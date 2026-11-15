# 6 · Concurrency, timeouts, retries, cancellation

Every wrapper here is a `Safe → Safe` factory — `exec` plus a signal, a timer
or a lane, never a fiber — and it meets a Safe inside `pipe`:

```ts
import { Pipe, Safe } from "@gjuoun/safe-ts";

const fetch: Safe<number, string> = Safe.ok(1);
const policy = { attempts: 3, delayMs: 10 };

// timeout bounds the whole retry loop
Safe.pipe(fetch, Pipe.retry(policy), Pipe.timeout(30_000));

// timeout bounds each attempt; the typed failure is what the policy sees
Safe.pipe(fetch, Pipe.timeout(2_000, () => "timeout" as const), Pipe.retry(policy));
```

Both spellings fold the same way: `Safe.pipe(safe, op1, op2)` and the method form
`safe.pipe(op1, op2)`. Variadic is the one to reach for — the types flow op by op;
a single op may also arrive in an array, `Safe.pipe(safe, [op])`. Both are lazy:
nothing runs until `Runtime.run`.

## `Safe.all` — fan out, keep order

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const fetchDoc = (id: string) => Safe.call(async () => `doc:${id}`);

const exit = await Runtime.run(Safe.all([fetchDoc("a"), fetchDoc("b")]));
console.log(exit); // { _tag: "success", value: ["doc:a", "doc:b"] }
```

The first `fail` or `die` aborts the siblings and becomes the result.
`Safe.allSettled` is its sibling that never fails: it returns every `Outcome`
in input order, so a caller reads `_tag` per element instead.

## `Safe.race` — first to settle

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const slow = Safe.call(async (s) => {
  await s.sleep(200);
  return "slow";
});
const fast = Safe.call(async () => "fast");

console.log(await Runtime.run(Safe.race([slow, fast]))); // { _tag: "success", value: "fast" }
```

The losers are aborted; a loser that ignores its signal still runs to
completion. `{ awaitLosers: true }` makes the winner return only after every
loser has actually settled — "the run returned" means "the work stopped".

## `Safe.forEach` — bounded fan-out

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const work = (n: number) => Safe.call(async () => n * 2);

const exit = await Runtime.run(Safe.forEach([1, 2, 3], work, { concurrency: 2 }));
console.log(exit); // { _tag: "success", value: [2, 4, 6] }
```

At `concurrency: n` a sliding window keeps n lanes in flight — a lane starts the
next item as soon as it finishes, so one slow item never blocks the wave behind
it. The first non-success aborts the rest; with no limit it is `Safe.all`.

## Timeouts

```ts
import { Outcome, Pipe, Runtime, Safe } from "@gjuoun/safe-ts";

const slow = Safe.call(async (s) => {
  await s.sleep(500);
  return "late";
});

console.log((await Runtime.run(slow.pipe(Pipe.timeout(10))))._tag); // "interrupt"
const mapped = await Runtime.run(slow.pipe(Pipe.timeout(10, () => "too_slow" as const)));
console.log(Outcome.isFail(mapped) ? mapped.error : mapped._tag); // "too_slow"
```

A timeout is an `interrupt` — the same arm a boundary abort produces — unless
you map it. The deadline waits on the run's clock, so `Clocks.manual()`
virtualises it.

## Retries, and the Policy that drives them

```ts
import { Pipe, Runtime, Safe } from "@gjuoun/safe-ts";

let attempts = 0;
const flaky = Safe.call(
  () => {
    attempts++;
    if (attempts < 3) throw new Error("not yet");
    return attempts;
  },
  () => "unavailable" as const,
);

console.log(await Runtime.run(flaky.pipe(Pipe.retry({ attempts: 3, delayMs: 5 }))));
// { _tag: "success", value: 3 }
```

A policy is a value — `(state) => ms | undefined` — assembled in the
`Policy` namespace the same way wrappers assemble in `Safe.pipe`:

```ts
import { Policy } from "@gjuoun/safe-ts";

// exponential backoff capped at 10 s per step — min keeps the shorter delay
Policy.min([Policy.exponential(250), Policy.spaced(10_000)]);

// exponential, jittered, hard stop after 6 attempts — one list, no nesting
Policy.pipe(Policy.exponential(250), [
  Policy.modifyDelay((d) => d * 0.8 + Math.random() * 0.4 * d),
  Policy.while((s) => s.attempt <= 6),
]);
```

Two rules keep the algebra honest: **gates go in `max`, caps go in `min`** —
`min` continues while any branch continues, so a gate there is silently
ignored — and `while`/`modifyDelay` are transformers, not policies, so a bare
one fed to `retry` is a compile error.

Only a typed `fail` is retried: a defect is a bug and an interrupt means
someone asked to stop. Each attempt gets its own scope, so a failed attempt's
resources are released before the next one starts — ahead of Effect here.

## Cancellation and interruptibility

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const program = Safe.try(function* () {
  yield* Safe.delay(500);
  return "never";
});

const exit = await Runtime.run(program, { signal: AbortSignal.timeout(10) });
console.log(exit._tag); // "interrupt"
```

### The Scheduler, member by member

`Safe.call` hands its callback a `Scheduler` bound to that run's signal and clock.
You never construct one, and it is released when the call settles — so register
what should stop *before* you start the work.

| member | use it for |
|---|---|
| `s.signal` | APIs that already take an `AbortSignal`: `fetch`, a DB driver, a subprocess |
| `s.onCancel(fn)` | what cannot take one: a timer, a socket, a worker |
| `s.sleep(ms)` | a cancellable wait; virtual on `Clocks.manual()` |
| `s.now()` | the run's clock — not `Date.now()`, which a manual clock cannot move |
| `s.aborted` | a cheap early exit |

Reach for `s.signal` first. It already carries every deadline and cancellation
above you (`timeout` folds its controller in with `AbortSignal.any`), so passing
it is the whole job:

```ts
import { Safe } from "@gjuoun/safe-ts";

const fetchTodo = (id: number) =>
  Safe.call((s) => fetch(`https://example.test/todos/${id}`, { signal: s.signal }));
```

`onCancel` is for what cannot take a signal. A promise built on `setTimeout` has
to clear its timer, or a cancelled call leaves it running:

```ts
import { Safe } from "@gjuoun/safe-ts";

const wait = (ms: number) =>
  Safe.call(
    (s) =>
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("done"), ms);
        s.onCancel(() => clearTimeout(timer));
      }),
  );
```

Two things surprise people:

- **An abort is `interrupt`, not `fail`.** The `mapErr` you passed to `Safe.call`
  never sees the `AbortError`; a rejection only becomes a typed failure when the
  run was *not* cancelled.
- **A run that starts already aborted never enters the body**, so `onCancel` is
  not a cleanup hook for resources that were never created.

`sleep` reads the run's clock, which is what makes deadlines testable — a manual
clock resolves every due wait without real time:

```ts
import { Clocks, Runtime, Safe } from "@gjuoun/safe-ts";

const { clock, advance } = Clocks.manual();
const exit = Runtime.run(Safe.call((s) => s.sleep(1000).then(() => "woke")), { clock });
advance(1000);
console.log(await exit); // { _tag: "success", value: "woke" }
```

Registering nothing costs nothing: with no signal (`Runtime.run(safe)`) the
Scheduler never attaches a listener, and a call that settles synchronously never
allocates one.

`uninterruptible` and `interruptible` are the region combinators —
combinator constants, no parens — for masking a deadline and opting a region
back in:

```ts
import { Pipe, Safe } from "@gjuoun/safe-ts";

declare const critical: Safe<number, never>;
declare const acquire: Safe<{ close(): void }, never>;
declare const close: (r: { close(): void }) => void;

// The region cannot be cut; the deadline is observed at the next step.
Safe.pipe(critical, [Pipe.uninterruptible]);

// Inside a masked region, `interruptible` restores the real signal —
// `acquireRelease`'s acquire is masked, so this is Effect's `restore`.
Safe.pipe(acquire, Pipe.interruptible, Pipe.acquireRelease(close));
```