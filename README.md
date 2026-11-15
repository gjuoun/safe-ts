# safe-ts

Typed errors and dependency-aware effects for TypeScript, without a fiber runtime.

One effect system: a lazy `Safe<A, E, R>`. Every question has exactly one answer.

| Question | Answer |
|---|---|
| a call can throw or reject | `Safe.call(fn, mapErr?)` — sync and async alike |
| a class needs dependencies and a lifetime | `get` / `provide` / `makeRuntime`, plus `dispose` or `acquireRelease` |

The rule that keeps it one system: **declare a mapper and the throw becomes a typed `fail`; omit it and the throw is a `die`** — a defect, never something you declared. No other construct in the library catches.

## One boundary

```ts
import { run, Safe } from "safe-ts";

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
await run(Safe.call(wait), { signal: AbortSignal.timeout(10) }); // interrupt
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
import { run, Safe } from "safe-ts";

const load = (path: string) =>
	Safe.try(async function* () {
		const text = yield* read(path);
		const config = yield* parse(text);
		if (!config.name) return yield* Safe.err("unnamed" as const);
		return config;
	}); // Safe<Config, "unreadable" | "bad_json" | "unnamed", never>

const exit = await run(load("./app.json"));
```

- `Safe.try` is lazy. It returns a `Safe`, and nothing runs until `run`. Each `run` runs the body again.
- Inside the body, `yield*` works on a `Safe` or on `get(Class)`. A failure stops the body there; `return value` succeeds.
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
import { get, instance, provide, run, Safe, Safe.try } from "safe-ts";

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
		const config = yield* get(Config);
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
	const db = yield* get(Db); // adds Db to R
	return yield* Safe.call(() => db.query("select 1"));
}); // Safe<Row[], never, typeof Db>

// The environment enters at the composition root, once.
const { DB_URL } = process.env;
run(program); // compile error: R is Db, not never
run(provide(program, [Db, instance(Config, new Config(DB_URL ?? "sqlite://app.db"))]));
```

- A service is a class with a generator `static *init()` (or `static async *init()`). The constructor takes what the class needs; `init` gets it.
- Dependencies are named in `init` with `yield* get(Other)`, not in the constructor. TypeScript erases parameter types at runtime, so `constructor(config: Config)` alone cannot tell the library to build a `Config`.
- `init` is always a generator — the same shape a `Safe.try` body has. It can `yield*` a `get` or a `Safe`, and it fails with `yield* Safe.err(e)`. A body with nothing to `yield` is still a generator: `static *init() { return new Config(url); }`. A plain `static init()` does not compile.
- A service reads no environment and no globals. Read them once at the composition root and hand the value in: `instance(Config, new Config(url))`.
- The classes an `init` gets are that class's requirements. The failures it yields join `E`.
- `provide(safe, [classes])` removes those classes from `R` and adds any requirements they leave unprovided, so an outer `provide` can supply them. `run` only accepts `R = never`.
- Each class builds once per `provide`, on first `get`. `init` is not interruptible.
- An instance that declares `*dispose()` (or `async *dispose()`) has it called, last-built first, when the scope that built it closes: the `provide` region, or `runtime.dispose()` for a runtime. It is a generator like `init`, driven by the same driver, so cleanup may `yield*` a `get(Dep)`; last-built-first order means a dependency is still alive when its dependents clean up.
- A `dispose` that is not a generator, or that fails, is a defect — the first names the rule (`*dispose() { … }`), the second follows any throwing finalizer.
- `dispose` is a name, not a language symbol: an instance used with `await using` will not be cleaned up by it.
- `instance(Db, new FakeDb())` uses a ready instance instead of calling `init` — the test seam, and how an environment value reaches a value-only service. A class with private fields can only be overridden by a subclass instance.

### `makeRuntime`

```ts
const runtime = makeRuntime([UserRepo, Db, Config]);
await runtime.run(handleRequest(req), { signal: req.signal });
await runtime.dispose();
```

`makeRuntime` builds classes on first use, shares the instances across `runtime.run(...)` calls, and disposes them on `runtime.dispose()`. The list must be closed: `makeRuntime([Db])` does not compile when `Db`'s `init` gets `Config`. A failed build is retried on the next run.

## Errors as data

```ts
import { defineErrors, type ErrorsOf, renderError } from "safe-ts";

const readError = defineErrors({
	not_found: (path: string) => ({ message: `no such file: ${path}`, path }),
	denied: (path: string, cause: unknown) => ({ message: `permission denied: ${path}`, path, cause }),
});
// { readonly not_found: { message: string; path: string } }
//   | { readonly denied: { message: string; path: string; cause: unknown } }
type ReadError = ErrorsOf<typeof readError>;

readError.not_found("/a"); // { not_found: { message: "no such file: /a", path: "/a" } }
renderError(readError.not_found("/a")); // "error: not_found\n\nno such file: /a"
```

- `defineErrors` wraps each factory's payload under its key. The key is the tag; the library adds no field of its own, so a `message` exists only because the factory declared one.
- Narrow by the key, not by a field: `"not_found" in error`. `CodeOf<E>` is the union of tags, `Arm<E, K>` the arm, `Payload<E, K>` its value.
- A factory may return `cause`, the equivalent of thiserror's `#[source]`. `renderError` prints it as `caused by:`, and a payload with no `message` renders as `error: <code>` alone.
- `Safe.catchTag(key, handler)` removes that variant from the error type, adds whatever the handler can fail with, and hands the handler the payload.

## Outcome

`run` never rejects. It returns one flat `Outcome`:

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

- `run(safe, { signal })` interrupts the run when the signal aborts. `Safe.try` stops before its next step. `Scheduler.sleep` and `Scheduler.onCancel` are how a callback cooperates.
- `Safe.all([...])` runs concurrently. The first `fail` or `die` aborts the others.
- `Safe.acquireRelease` and `Safe.scoped` register cleanup. Releases run last-in, first-out on success, fail, die and interrupt.

## Not included

Fibers, `fork`/`join`, retry and schedule operators, a `timeout` operator (pass `AbortSignal.timeout(ms)` to `run`), decorators or a DI container, streams, schemas and tracing.

Also deliberately absent: a second effect type, a second boundary, and a second outcome type. The eager `Result` layer — its combinators, its two boundary adapters and its standalone `catchTag` — is gone, along with the `Safe` constructors that duplicated `Safe.call`, `Safe.ok` and `Safe.err`, and the nested cause type that duplicated `Outcome`'s failure arms. Each question above has exactly one answer.

## Examples

Each file under `examples/` runs standalone (`bun run <file>`), easy to hard:

| File | Covers |
|---|---|
| `examples/01-boundaries.ts` | `Safe.call` with and without a mapper, `fail` vs `die`, `Scheduler.sleep` |
| `examples/02-safe-try.ts` | `Safe.try` laziness, `yield*` on a `Safe`, `finally` on early stop |
| `examples/03-typed-errors.ts` | `defineErrors`, `Safe.catchTag`, `renderError`, `die` vs `fail` |
| `examples/04-services.ts` | class services, `get`, `provide`, `instance`, `dispose` |
| `examples/05-concurrency-and-cleanup.ts` | `Safe.all`, `Scheduler.sleep`, `acquireRelease`, `scoped` |
| `examples/user-service.ts` | all of it end to end with `makeRuntime` and `Scheduler.onCancel` |

## Develop

```sh
bun install
bun run check # typecheck, lint, test
bun run examples/01-boundaries.ts # any file under examples/ runs standalone
```

Type-level behavior is tested in `test/types/*.ts` with `@ts-expect-error`. If a type gate stops rejecting, `tsc` fails with TS2578.