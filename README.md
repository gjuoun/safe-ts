# safe-ts

Typed errors and dependency-aware effects for TypeScript, without a fiber runtime.

One effect system: a lazy `Safe<A, E, R>`. Every question has exactly one answer.

| Question | Answer |
|---|---|
| a call can throw or reject | `Safe.call(fn, mapErr?)` — sync and async alike |
| a class needs dependencies and a lifetime | `Services.get` / `Services.provide` / `Runtime.make`, plus `dispose` or `acquireRelease` |

The rule that keeps it one system: **declare a mapper and the throw becomes a typed `fail`; omit it and the throw is a `die`** — a defect, never something you declared. No other construct in the library catches.

## One boundary

```ts
import { Safe } from "safe-ts";

const parse = (text: string) =>
	Safe.call(
		() => JSON.parse(text) as Config,
		(): "bad_json" => "bad_json",
	); // Safe<Config, "bad_json", never>

const read = (path: string) =>
	Safe.call(
		() => readFile(path, "utf8"),
		(): "unreadable" => "unreadable",
	); // Safe<string, "unreadable", never>

const lenient = Safe.call(() => JSON.parse(text)); // a throw here is a `die`
```

`Safe.call` takes a function that returns a value *or* a promise — the two cases are the same case, and both infer `Safe<Awaited<A>, E, never>`. Together with the driver `exec`, it is the only place a throw is caught; nothing in this library throws at you.

## Cancellation: `Scheduler`

The callback receives a `Scheduler` instead of a bare `AbortSignal`. It owns the one `abort` listener and drops it when the call settles, so there is no listener to wire and none to leak.

```ts
const wait = (s: Scheduler) => s.sleep(500).then(() => "late");
await Runtime.run(Safe.call(wait), { signal: AbortSignal.timeout(10) }); // interrupt
```

| | |
|---|---|
| `s.signal` | the run's signal, for APIs that take one (`fetch`, `fs`) |
| `s.aborted` | whether the run has already been cancelled |
| `s.onCancel(fn)` | run `fn` on cancel; returns an unregister function |
| `s.sleep(ms)` | resolve after `ms`, reject with the signal's reason on cancel |

- Hand-wiring an `abort` listener on the signal instead is what this replaces: `{ once: true }` only fires on abort, so a call that resolves normally never removes its listener — measured at 100 residual listeners over 100 runs.
- A throw inside an `onCancel` callback makes the settle a `die`, following the same rule as a throwing finalizer.

## Sequencing: `Safe.try`

```ts
import { Safe } from "safe-ts";

const load = (path: string) =>
	Safe.try(async function* () {
		const text = yield* read(path);
		const config = yield* parse(text);
		if (!config.name) return yield* Safe.err("unnamed" as const);
		return config;
	}); // Safe<Config, "unreadable" | "bad_json" | "unnamed", never>

const exit = await Runtime.run(load("./app.json"));
```

- `Safe.try` is lazy. It returns a `Safe`, and nothing runs until `Runtime.run`. Each `Runtime.run` runs the body again.
- Inside the body, `yield*` works on a `Safe` or on `Services.get(Class)`. A failure stops the body there; `return value` succeeds.
- When a `yield*` stops the body early, its `finally` blocks run (neverthrow #696 does not). An async body can `await` in `finally`.
- The generator is the combinator: there is no `map` or `andThen`.

### The rest of `Safe`

| | Behaviour |
|---|---|
| `Safe.ok(v)` / `Safe.err(e)` | a constant success / a declared error |
| `Safe.try(function* () {})` | sequence Safes; the generator is the only combinator |
| `Safe.all([...])` | concurrent, ordered results; the first failure aborts the rest |
| `Safe.catchTag(key, handler)` | recover one error variant by its key; defects pass through |
| `Safe.acquireRelease(acquire, release)` | acquire a resource, release it on every exit |
| `Safe.scoped(safe)` | run in a fresh scope; its releases run as soon as it exits |

## Services: plain classes

```ts
import { Safe, Services } from "safe-ts";

// A value-only service: it reads no environment of its own.
class Config {
	constructor(readonly url: string) {}
	static init() {
		return new Config("sqlite://app.db");
	}
}

class Db {
	constructor(private readonly pool: Pool) {}
	static async *init() {
		const config = yield* Services.get(Config);
		if (!config.url) return yield* Safe.err(dbError.no_url());
		return new Db(await connect(config.url));
	}

	query(sql: string) {
		return this.pool.query(sql);
	}

	async *dispose() {
		await this.pool.end();
	}
}

const program = Safe.try(async function* () {
	const db = yield* Services.get(Db); // adds Db to R
	return yield* Safe.call(() => db.query("select 1"));
}); // Safe<Row[], never, typeof Db>

// The environment enters at the composition root, once.
const { DB_URL } = process.env;
Runtime.run(program); // compile error: R is Db, not never
Runtime.run(Services.provide(program, [Db, Services.new(Config, new Config(DB_URL ?? "sqlite://app.db"))]));
```

- A service is a class with a generator `static *init()` (or `static async *init()`). The constructor takes what the class needs; `init` gets it.
- Dependencies are named in `init` with `yield* Services.get(Other)`, not in the constructor. TypeScript erases parameter types at runtime, so `constructor(config: Config)` alone cannot tell the library to build a `Config`.
- `init` is always a generator — the same shape a `Safe.try` body has. It can `yield*` a `Services.get` or a `Safe`, and it fails with `yield* Safe.err(e)`. A body with nothing to `yield` is still a generator: `static *init() { return new Config(url); }`. A plain `static init()` does not compile.
- A service reads no environment and no globals. Read them once at the composition root and hand the value in: `Services.new(Config, new Config(url))`.
- The classes an `init` gets are that class's requirements. The failures it yields join `E`.
- `Services.provide(safe, [classes])` removes those classes from `R` and adds any requirements they leave unprovided, so an outer `Services.provide` can supply them. `Runtime.run` only accepts `R = never`.
- Each class builds once per `Services.provide`, on first `Services.get`. `init` is not interruptible.
- An instance that declares `*dispose()` (or `async *dispose()`) has it called, last-built first, when the scope that built it closes: the `Services.provide` region, or `runtime.dispose()` for a runtime. It is a generator like `init`, driven by the same driver, so cleanup may `yield*` a `Services.get(Dep)`; last-built-first order means a dependency is still alive when its dependents clean up.
- A `dispose` that is not a generator, or that fails, is a defect — the first names the rule (`*dispose() { … }`), the second follows any throwing finalizer.
- `dispose` is a name, not a language symbol: an instance used with `await using` will not be cleaned up by it.
- `Services.new(Db, new FakeDb())` uses a ready instance instead of calling `init` — the test seam, and how an environment value reaches a value-only service. A class with private fields can only be overridden by a subclass instance.

### `Runtime.make`

```ts
const runtime = Runtime.make([UserRepo, Db, Config]);
await runtime.run(handleRequest(req), { signal: req.signal });
await runtime.dispose();
```

`Runtime.make` builds classes on first use, shares the instances across `runtime.run(...)` calls, and disposes them on `runtime.dispose()`. The list must be closed: `Runtime.make([Db])` does not compile when `Db`'s `init` gets `Config`. A failed build is retried on the next run.

## Errors as data

```ts
import { Errors, type ErrorsOf } from "safe-ts";

const readError = Errors.define({
	not_found: (path: string) => ({ message: `no such file: ${path}`, path }),
	denied: (path: string, cause: unknown) => ({ message: `permission denied: ${path}`, path, cause }),
});
// { readonly not_found: { message: string; path: string } }
//   | { readonly denied: { message: string; path: string; cause: unknown } }
type ReadError = ErrorsOf<typeof readError>;

readError.not_found("/a"); // { not_found: { message: "no such file: /a", path: "/a" } }
Errors.render(readError.not_found("/a")); // "error: not_found\n\nno such file: /a"
```

- `Errors.define` wraps each factory's payload under its key. The key is the tag; the library adds no field of its own, so a `message` exists only because the factory declared one.
- Narrow by the key, not by a field: `"not_found" in error`. `CodeOf<E>` is the union of tags, `Arm<E, K>` the arm, `Payload<E, K>` its value.
- A factory may return `cause`, the equivalent of thiserror's `#[source]`. `Errors.render` prints it as `caused by:`, and a payload with no `message` renders as `error: <code>` alone.
- `Safe.catchTag(key, handler)` removes that variant from the error type, adds whatever the handler can fail with, and hands the handler the payload.

## Outcome

`Runtime.run` never rejects. It returns one flat `Outcome`:

```ts
type Outcome<A, E> =
	| { _tag: "success"; value: A }
	| { _tag: "fail"; error: E } // a typed error you declared
	| { _tag: "die"; defect: unknown } // something threw
	| { _tag: "interrupt" }; // the run's AbortSignal fired
```

A throw anywhere in user code — a `Safe.try` body, a service `init`, an unmapped `Safe.call` — is a `die`, never a `fail`. Use the mapper form to turn a throw into a typed error.

`Outcome.isSuccess`/`isFail`/`isDie`/`isInterrupt` narrow the union; `Outcome.succeed`/`fail`/`die`/`interrupt` build it. A failure is a tag on the outcome, not a nested cause — there is no second type.

## Interruption and cleanup

- `Runtime.run(safe, { signal })` interrupts the run when the signal aborts. `Safe.try` stops before its next step. `Scheduler.sleep` and `Scheduler.onCancel` are how a callback cooperates.
- `Safe.all([...])` runs concurrently. The first `fail` or `die` aborts the others.
- `Safe.acquireRelease` and `Safe.scoped` register cleanup. Releases run last-in, first-out on success, fail, die and interrupt.

## Scheduling: timeout, retry, fan-out

Three combinators, none of which needs a runtime — each is `exec` plus a signal, a
timer or a batch:

```ts
Safe.timeout(safe, ms)                         // a timeout arrives as an interrupt
Safe.timeout(safe, ms, () => "too_slow")       // …or as a typed failure
Safe.retry(safe, { attempts: 3, delayMs: 50 }) // retries a fail; never a die or an interrupt
Safe.forEach(items, (x) => work(x), { concurrency: 4 })
Safe.race([primary, replica])                  // first to settle wins, losers abort
Safe.sleep(50)                                 // an abort during the wait is an interrupt
Safe.ensuring(safe, (exit) => log(exit))       // cleanup on success, fail, die, interrupt
```

- `retry` gives each attempt its own scope, so a failed attempt's resources are
  released before the next one starts.
- `forEach` without a limit runs everything at once (`Safe.all`); with one it runs
  sequential batches, so a failure stops every later batch.
- `race` starts the children in order and keeps the first to settle — success or
  failure. A synchronous child wins without starting the rest; the losers abort.
- `ensuring` always runs, and a throwing cleanup turns a success into a defect while
  leaving a failure alone — the same rule `Scope.close` applies.
- A timeout interrupts at the next suspension point. A body that is entirely
  synchronous cannot be interrupted mid-flight — the same rule the run boundary follows.

## Not included

Fibers, `fork`/`join`, priorities or a yield policy — the pieces that would require
owning a scheduling loop, which is what Effect's runtime is. Decorators or a DI
container, streams, schemas and tracing.

Also deliberately absent: a second effect type, a second boundary, and a second outcome type. The eager `Result` layer — its combinators, its two boundary adapters and its standalone `catchTag` — is gone, along with the `Safe` constructors that duplicated `Safe.call`, `Safe.ok` and `Safe.err`, and the nested cause type that duplicated `Outcome`'s failure arms. Each question above has exactly one answer.

## Examples

Each file under `examples/` runs standalone (`bun run <file>`), easy to hard:

| File | Covers |
|---|---|
| `examples/01-boundaries.ts` | `Safe.call` with and without a mapper, `fail` vs `die`, `Scheduler.sleep` |
| `examples/02-safe-try.ts` | `Safe.try` laziness, `yield*` on a `Safe`, `finally` on early stop |
| `examples/03-typed-errors.ts` | `Errors.define`, `Safe.catchTag`, `Errors.render`, `die` vs `fail` |
| `examples/04-services.ts` | class services, `Services.get`, `Services.provide`, `Services.new`, `dispose` |
| `examples/05-concurrency-and-cleanup.ts` | `Safe.all`, `Scheduler.sleep`, `acquireRelease`, `scoped` |
| `examples/user-service.ts` | all of it end to end with `Runtime.make` and `Scheduler.onCancel` |

## Performance

Measured on the same four-step program — parse JSON, look up a name, recover a
`not_found` — with the handler built once and executed per call (the shape a
server actually has). Bun 1.3.14, arm64, 200,000 iterations, best of 5:

| scenario | safe-ts | Effect (`runSync`) | neverthrow |
|---|---|---|---|
| two calls, success | 319 ns/op | 334 ns/op | 423 ns/op |
| recovered `not_found` | 387 ns/op | 357 ns/op | 422 ns/op |
| ten `Safe.call` steps | 786 ns/op | 706 ns/op | 557 ns/op |
| ten `Safe.ok` steps | 379 ns/op | 442 ns/op | 478 ns/op |
| throw → typed error | 855 ns/op | 842 ns/op | 844 ns/op |
| async step, sync body | 627 ns/op | n/a | 787 ns/op |

An async step does **not** need an `async function*` body. A sync generator holding
`yield* Safe.call(async () => …)` runs the same program at **627 ns/op**, where the
`async function*` form costs **980** — an async generator turns every `next()` into a
promise and wraps each delegation hop in an async-from-sync conversion. Effect never
pays that: its `gen` is always a sync generator, with async work carried as a value.
With the sync body, one async step costs the same as Effect's (627 against 639).

The harness is `bun run /tmp/jun/bench6/run.ts` — seven scenarios, three
libraries, parity asserted first (every lane prints the same result before any
timing), no rendering inside the timed loop. safe-ts and Effect are measured
with the handler built once; neverthrow has no build/run split, so its column
is build+run.

### Hot path: `yield` instead of `yield*`

`yield*` delegates: per yielded step the engine saves the generator frame,
dispatches a builtin, re-enters with five hidden arguments and allocates a
result object. A plain `yield` hands the `Safe` straight to the driver.

| body | ns/op |
|---|---|
| `const n = yield* lookup(id)` | 452 |
| `const n = (yield lookup(id)) as string` | 400 |

Same program, same outcome — the cast is the price, because a plain `yield`
resumes with `TNext` rather than the Safe's `A`. Use `yield*` for readability,
`yield` inside a handler that runs per request.

A step that cannot fail is free: `yield* Safe.ok(x)` completes the delegation
inline with `x`, without a driver round-trip, an `exec` or an `Outcome`
(measured: two such steps cost 71 ns/op where two `Safe.call` steps cost ~300).
The idea comes from neverthrow, whose `Ok` iterator returns its value without
yielding — but not its `Err` half, which surfaces a failure by leaving the body
suspended, so a `finally` never runs. Here the driver closes the body instead.

Two rules keep it there: a body that finished synchronously returns an
`Outcome`, not a promise (`Safe.body`, `exec`, `drive` and `Scope.close` all
take the sync branch), and the abort listener is attached only when something
can observe cancellation. `Runtime.run` still returns a `Promise` — one per run,
at the boundary.

## Develop

```sh
bun install
bun run check # typecheck, lint, test
bun run examples/01-boundaries.ts # any file under examples/ runs standalone
```

Type-level behavior is tested in `test/types/*.ts` with `@ts-expect-error`. If a type gate stops rejecting, `tsc` fails with TS2578.