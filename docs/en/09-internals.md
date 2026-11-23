# 9 · Internals: the semantics the code used to carry in comments

This chapter holds the design notes that lived in source comments before the
"no comments in code" rule. Read it before changing `src/`.

## `Safe.call` is the only boundary

Everything a Safe can do flows through one constructor:

- `Safe.call(fn)` — `fn` runs at `run` time (lazy, per run). A throw with no
  `mapErr` is a `die` — a defect, never a declared failure.
- `Safe.call(fn, mapErr)` — `mapErr` declared: a throw or rejection becomes
  `fail(mapErr(thrown))`.
- `Safe.call` rejects a generator function: sequencing is `Safe.try`'s job, and
  accepting one here would silently misroute it.
- The scheduler given to `fn` is the run's own `CallScheduler`: sleeps, timers
  and `onCancel` are bound to the run's signal and clock, so a cancellation is
  not an extra listener on every call.

`sealed = true` on a call means its promise already converts rejections into
`Outcome`, so `exec` need not wrap it — a hot-path shortcut.

## `Safe.try`: sequencing and the implicit scope

`Safe.try` runs a generator body:

- `yield* safe` drives the Safe and resumes with its value; a non-success
  Outcome stops the body.
- `yield safe` (plain yield) is the hot-path form — skips `yield*`'s delegation
  loop, ~26 ns per step; the value arrives as `TNext`, so it needs a cast.
- The body is lazy: nothing runs until `run`, and each `run` runs it again —
  which is what `retry` relies on.

**Implicit scope:** the body runs in a fresh `Scope` that closes when the body
produces its Outcome — success, failure, defect or interrupt. `Safe.defer`
registers there, so a `defer` inside a `try` settles at the body exit — the
`using`-block boundary. This is a semantic choice: resources live exactly as
long as the code that uses them.

## `Safe.defer`: the one cleanup primitive

Two overloads, one rule — "the last argument is what runs at scope exit":

```ts
import { Safe } from "@gjuoun/safe-ts";

declare const metrics: { end(tag: string): void };
declare const open: () => Safe<{ close(): void }, never>;

const program = Safe.try(function* () {
  yield* Safe.defer((outcome) => metrics.end(outcome._tag));
  const conn = yield* Safe.defer(open(), (c, outcome) => c.close());
  return conn;
});
```

**Why the two-arg form exists:** if acquire and registration were two yields, an
abort between them would leave a live resource with no release. The two-arg
form runs `acquire` under `NEVER_ABORTED` and registers the release in the
same step — either nothing was taken, or it was taken and a release is
registered. Registration precedes the interrupt check: an already-aborted run
still records the finalizer.

`Pipe.defer(fn)` is the same idea bound to one Safe — it needs no scope and
fires the moment that Safe settles.

## `Outcome`: four arms, one classification

`success | fail | die | interrupt` — every way work can end, flat, no nesting.
`die` is a defect: a throw nobody declared. `interrupt` is cancellation.
Returning `Outcome` itself from a yield (rather than a wrapper) saves one
allocation per step.

## Scopes and finalizers

`Scope` collects `Finalizer`s and runs them LIFO on `close`:

- Every finalizer runs even if an earlier one throws.
- A throwing finalizer turns a `success` into `die`; any other outcome keeps
  its own cause.
- `run` creates the root `Scope`; `Safe.try` creates one per body; `retry`
  creates one per attempt — resources from a failed attempt are released before
  the next.

## Interruption: cooperative, not forced

`uninterruptible` masks the run's signal for a region; `interruptible`
restores it inside. An abort during a mask is observed at the mask's exit —
the outcome becomes `interrupt`, and a `die` stays a `die`. Stopping is
signal-cooperative: a body that ignores its signal keeps running until it
settles.

## The driver

`drive` pumps the generator: sync loop for sync steps, async continuation the
moment a step's promise is real. On a non-success step or an aborted signal it
calls `it.return()` — which runs every `finally` in the body, async ones
awaited — then folds the outcome through `closedOutcome` (a throwing finally
is a defect only when the body succeeded).
