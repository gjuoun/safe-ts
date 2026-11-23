# 5 · Cleanup that always runs

`Safe.defer` is the one cleanup primitive. It registers on the enclosing scope —
which every `Safe.try` provides — and the cleanup runs on **every** exit:
success, fail, die and interrupt.

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const program = Safe.try(function* () {
  const conn = yield* Safe.defer(
    Safe.call(() => ({ open: true })),
    (_db, exit) => console.log(`release after ${exit._tag}`),
  );
  return yield* Safe.err("boom" as const);
});

console.log((await Runtime.run(program))._tag);
// release after fail, then "fail"
```

The two-argument form runs `acquire` uninterruptibly, then pairs the resource
with its release atomically — either the resource was never taken, or it was
taken and a release is registered. The cleanup settles when the body's scope
closes: the `using`-block boundary.

## `Safe.defer(fn)`: cleanup without a resource

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const timed = Safe.try(function* () {
  yield* Safe.defer((exit) => console.log(`always: ${exit._tag}`));
  return yield* Safe.ok(1);
});
console.log(await Runtime.run(timed)); // always: success, then success
```

## `Pipe.defer`: cleanup bound to one Safe

The pipe twin attaches to a single Safe and fires the moment it settles — no
scope involved, no `try` needed:

```ts
import { Pipe, type Safe } from "@gjuoun/safe-ts";

declare const fetchUser: (id: string) => Safe<{ id: string }, never>;
declare const metrics: { end(tag: string): void };

const work = fetchUser("u1").pipe(
  Pipe.defer((exit) => metrics.end(exit._tag)),
);
```

## `Pipe.scoped`: a shared window across `try`s

A `Safe.try` already scopes its own `defer`s. Reach for `Pipe.scoped` only
when resources from several `Safe.try` bodies must share one lifetime:

```ts
import { Pipe, Safe } from "@gjuoun/safe-ts";

declare const openA: () => Safe<{ close(): void }, never>;
declare const inner: () => Safe<number, never>;

const shared = Safe.try(function* () {
  const a = yield* Safe.defer(openA(), c => c.close());
  yield* inner();   // inner's defers already closed; a still lives
}).pipe(Pipe.scoped);
```

## The rules

- Releases run **last-in, first-out**.
- A throwing release turns a success into a `die`; a failure keeps its own error.
- A release may be async, or a generator, and may itself `yield*` a service.
- If the run is aborted, the release still runs — that is the point of registering it.

`s.onCancel(fn)` is different: it stops an **in-flight operation** only on
cancellation, for example by calling a database client's `cancel()`. It does
not run on success or ordinary failure, and its callback is synchronous.
Use `Safe.defer` or `Pipe.defer` for cleanup that must run on every exit.
See [Scheduler and cancellation](./08-scheduler.md).

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const slow = Safe.try(function* () {
  yield* Safe.defer(Safe.ok("conn"), () => console.log("closed"));
  yield* Safe.delay(500);
  return "never";
});

const exit = await Runtime.run(slow, { signal: AbortSignal.timeout(10) });
console.log(exit._tag); // "interrupt", and "closed" was printed
```
