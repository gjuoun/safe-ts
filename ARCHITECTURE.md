# Architecture

One lazy `Safe<A, E>`: a description of work that runs only at `Runtime.run`.
Everything below is semantics the code cannot carry in comments — source files
have none; this document and `docs/en|zh/09-internals.md` are where they live.

## The four pieces

```
Safe<A, E>          a lazy description: succeeds with A, fails with E
Outcome<A, E>       how it ended: success | fail | die | interrupt
Scope               a LIFO finalizer list; every exit closes it
Scheduler           the run's clock + signal surface given to Safe.call
```

## `Safe.call` is the only boundary

Every effect enters through one constructor. `fn` runs at `run` time (lazy,
per run). A throw with no `mapErr` is a `die`; declared, it becomes
`fail(mapErr(thrown))`. A generator function is refused — sequencing belongs
to `Safe.try`, and accepting it here would silently misroute the body.

## `Safe.try`: sequencing + implicit scope

A generator body: `yield* safe` drives it and resumes with the value;
a non-success Outcome stops the body. The body owns a `Scope` that closes
when it produces its Outcome — the `using`-block boundary. `Safe.defer`
registers there, so defers inside a `try` settle at the body exit. This is
the semantic choice: a resource lives exactly as long as the code that uses it.

## `Safe.defer`: the one cleanup primitive

```ts
yield* Safe.defer(outcome => cleanup);          // register a finalizer
yield* Safe.defer(acquire, (res, outcome) => release);  // atomic acquire + release
```

The two-arg form runs `acquire` under `NEVER_ABORTED` and registers the
release in the same step — either nothing was taken, or it was taken and a
release is registered. Registration precedes the interrupt check: an
already-aborted run still records the finalizer. `Pipe.defer(fn)` is the
per-Safe twin — no scope needed, fires the moment that Safe settles.

## Outcome: four arms, one classification

`success | fail | die | interrupt` — every way work can end, flat. `die` is a
defect (an undeclared throw); `interrupt` is cancellation. A yield returns
the `Outcome` itself, saving an allocation per step.

## Interruption: cooperative, not forced

`uninterruptible` masks the signal for a region; `interruptible` restores
it inside. An abort during a mask is observed at the mask's exit — outcome
becomes `interrupt`, a `die` stays a `die`. Stopping is signal-cooperative:
a body that ignores its signal keeps running until it settles.

## Scopes

`run` creates the root `Scope`; `Safe.try` creates one per body; `retry`
creates one per attempt — a failed attempt's resources are released before the
next. `Pipe.scoped` gives several `try` bodies a shared window. Finalizers
run LIFO; a throwing one turns `success` into `die`, any other outcome
keeps its cause.

## The driver

`drive` pumps the generator: sync loop for sync steps, async continuation the
moment a step's promise is real. On a non-success step or an aborted signal it
calls `it.return()` — every `finally` in the body runs, async ones awaited —
then folds through `closedOutcome` (a throwing `finally` is a defect only
when the body succeeded).

## Pipe: the Safe → Safe ops

`timeout, retry, defer, scoped, catchTag, uninterruptible, interruptible` —
seven ops, one fold (`Safe.pipe` / `.pipe`). Each is `exec` plus a signal,
a timer or a batch; none needs a fiber loop. `fork`/`join` is the one that
does, and it stays out.

## No comments in source

By rule (`bun run lint` → `scripts/no-comments.ts`), .ts files carry no
comments — not `//`, not `/* */`, not `/** */`. Design intent lives in this
file and `docs/en|zh/09-internals.md`. The lint rule exists because the
compiler's scanner is the only thing that sees comments (trivia never reaches
the AST a GritQL plugin would match against).
