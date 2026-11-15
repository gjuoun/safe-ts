# 5 · Cleanup that always runs

`acquireRelease` pairs a resource with its release. The release runs on
**every** exit: success, fail, die and interrupt. It is a `Safe → Safe`
factory — it wraps the Safe inside `pipe`, like every wrapper.

```ts
import { Pipe, Runtime, Safe } from "@gjuoun/safe-ts";

const openDb = () =>
  Safe.call(() => ({ open: true })).pipe(
    Pipe.acquireRelease((_db: { open: boolean }, exit) =>
      console.log(`release after ${exit._tag}`),
    ),
  );

const program = Safe.try(function* () {
  const db = yield* openDb();
  return yield* Safe.err("boom" as const);
});

console.log((await Runtime.run(program))._tag); // release after fail, then "fail"
```

`scoped` gives that work its own scope, which closes as soon as it exits —
it is a combinator constant, so it pipes without parens:

```ts
import { Pipe, Runtime, Safe } from "@gjuoun/safe-ts";

const work = Safe.try(function* () {
  yield* Safe.ok("conn").pipe(Pipe.acquireRelease(() => console.log("closed")));
  return "done";
}).pipe(Pipe.scoped);

console.log(await Runtime.run(work)); // closed, then success
```

## `ensuring`: cleanup without a resource

```ts
import { Pipe, Runtime, Safe } from "@gjuoun/safe-ts";

const timed = Safe.ok(1).pipe(Pipe.ensuring((exit) => console.log(`always: ${exit._tag}`)));
console.log(await Runtime.run(timed)); // always: success, then success
```

## The rules

- Releases run **last-in, first-out**.
- A throwing release turns a success into a `die`; a failure keeps its own error.
- A release may be async, or a generator, and may itself `yield*` a service.
- If the run is aborted, the release still runs — that is the point of registering it.

```ts
import { Pipe, Runtime, Safe } from "@gjuoun/safe-ts";

const slow = Safe.try(function* () {
  yield* Safe.ok("conn").pipe(Pipe.acquireRelease(() => console.log("closed")));
  yield* Safe.delay(500);
  return "never";
}).pipe(Pipe.scoped);

const exit = await Runtime.run(slow, { signal: AbortSignal.timeout(10) });
console.log(exit._tag); // "interrupt", and "closed" was printed
```
