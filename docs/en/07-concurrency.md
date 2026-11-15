# 7 · Concurrency, timeouts, retries, cancellation

Every combinator here is built from `exec` plus a signal, a timer or a batch. There is
no fiber, no scheduler loop — the platform's event loop does the scheduling.

## `Safe.all` — fan out, keep order

```ts
import { Runtime, Safe } from "safe-ts";

const fetchDoc = (id: string) => Safe.call(async () => `doc:${id}`);

const exit = await Runtime.run(Safe.all([fetchDoc("a"), fetchDoc("b")]));
console.log(exit); // { _tag: "success", value: ["doc:a", "doc:b"] }
```

The first `fail` or `die` aborts the siblings and becomes the result.

## `Safe.race` — first to settle

```ts
import { Runtime, Safe } from "safe-ts";

const slow = Safe.call(async (s) => {
  await s.sleep(200);
  return "slow";
});
const fast = Safe.call(async () => "fast");

console.log(await Runtime.run(Safe.race([slow, fast]))); // { _tag: "success", value: "fast" }
```

The losers are aborted; a loser that ignores its signal still runs to completion.

## `Safe.forEach` — bounded fan-out

```ts
import { Runtime, Safe } from "safe-ts";

const work = (n: number) => Safe.call(async () => n * 2);

const exit = await Runtime.run(Safe.forEach([1, 2, 3], work, { concurrency: 2 }));
console.log(exit); // { _tag: "success", value: [2, 4, 6] }
```

## Timeouts

```ts
import { Outcome, Runtime, Safe } from "safe-ts";

const slow = Safe.call(async (s) => {
  await s.sleep(500);
  return "late";
});

console.log((await Runtime.run(Safe.timeout(slow, 10)))._tag); // "interrupt"
const mapped = await Runtime.run(Safe.timeout(slow, 10, () => "too_slow" as const));
console.log(Outcome.isFail(mapped) ? mapped.error : mapped._tag); // "too_slow"
```

A timeout is an `interrupt` — the same arm a boundary abort produces — unless you map it.

## Retries

```ts
import { Runtime, Safe } from "safe-ts";

let attempts = 0;
const flaky = Safe.call(
  () => {
    attempts++;
    if (attempts < 3) throw new Error("not yet");
    return attempts;
  },
  () => "unavailable" as const,
);

console.log(await Runtime.run(Safe.retry(flaky, { attempts: 3, delayMs: 5 })));
// { _tag: "success", value: 3 }
```

Only a typed `fail` is retried: a defect is a bug and an interrupt means someone
asked to stop. Each attempt gets its own scope, so a failed attempt's resources are
released before the next one starts.

## Cancellation

```ts
import { Runtime, Safe } from "safe-ts";

const program = Safe.try(function* () {
  yield* Safe.sleep(500);
  return "never";
});

const exit = await Runtime.run(program, { signal: AbortSignal.timeout(10) });
console.log(exit._tag); // "interrupt"
```

Inside a callback the `Scheduler` is how you cooperate: `s.sleep(ms)` waits on the
run's signal, `s.onCancel(fn)` registers what should stop, `s.signal` goes to APIs
that take one.
