# 6 · Cleanup that always runs

`Safe.acquireRelease` pairs a resource with its release. The release runs on
**every** exit: success, fail, die and interrupt.

```ts
import { Runtime, Safe } from "safe-ts";

const openDb = () =>
  Safe.acquireRelease(
    Safe.call(() => ({ open: true })),
    (_db, exit) => console.log(`release after ${exit._tag}`),
  );

const program = Safe.try(function* () {
  const db = yield* openDb();
  return yield* Safe.err("boom" as const);
});

console.log((await Runtime.run(program))._tag); // release after fail, then "fail"
```

`Safe.scoped` gives that work its own scope, which closes as soon as it exits:

```ts
import { Runtime, Safe } from "safe-ts";

const work = Safe.scoped(
  Safe.try(function* () {
    yield* Safe.acquireRelease(Safe.ok("conn"), () => console.log("closed"));
    return "done";
  }),
);

console.log(await Runtime.run(work)); // closed, then success
```

## `ensuring`: cleanup without a resource

```ts
import { Runtime, Safe } from "safe-ts";

const timed = Safe.ensuring(Safe.ok(1), (exit) => console.log(`always: ${exit._tag}`));
console.log(await Runtime.run(timed)); // always: success, then success
```

## The rules

- Releases run **last-in, first-out**.
- A throwing release turns a success into a `die`; a failure keeps its own error.
- A release may be async, or a generator, and may itself `yield*` a service.
- If the run is aborted, the release still runs — that is the point of registering it.

```ts
import { Runtime, Safe } from "safe-ts";

const slow = Safe.scoped(
  Safe.try(function* () {
    yield* Safe.acquireRelease(Safe.ok("conn"), () => console.log("closed"));
    yield* Safe.sleep(500);
    return "never";
  }),
);

const exit = await Runtime.run(slow, { signal: AbortSignal.timeout(10) });
console.log(exit._tag); // "interrupt", and "closed" was printed
```
