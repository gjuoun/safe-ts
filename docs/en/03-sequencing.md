# 3 · Sequencing: `Safe.try`

`Safe.try` takes a generator body. `yield*` a `Safe` and you get its value; a failure
stops the body there and becomes the result.

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const parse = (text: string) =>
  Safe.call(() => JSON.parse(text) as { name: string }, (): "bad_json" => "bad_json");

const program = Safe.try(function* () {
  const config = yield* parse('{"name":"demo"}');
  if (!config.name) return yield* Safe.err("missing_name" as const);
  return config;
});

console.log(await Runtime.run(program));
// { _tag: "success", value: { name: "demo" } }
```

An early stop still runs `finally` blocks, so cleanup written the normal way is kept:

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const traced = Safe.try(function* () {
  try {
    return yield* Safe.err("boom" as const);
  } finally {
    console.log("cleanup runs");
  }
});

console.log((await Runtime.run(traced))._tag); // cleanup runs, then "fail"
```

## The body stays sync

A sync body can yield async Safes — `yield*` is the sequencing, not `await`:

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const slow = Safe.call(async () => "loaded");

const program = Safe.try(function* () {
  const value = yield* slow; // no async keyword needed
  return value.toUpperCase();
});

console.log(await Runtime.run(program)); // { _tag: "success", value: "LOADED" }
```

An `async function*` body works too, but it costs about twice as much at run time
(chapter 7): every `next()` becomes a promise. Prefer the sync body.

## `yield` instead of `yield*` in hot paths

A plain `yield` hands the `Safe` straight to the driver instead of going through
`yield*`'s delegation loop — about 26 ns cheaper per step. The value comes back as
`TNext`, so it needs a cast:

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const program = Safe.try(function* () {
  const n = (yield Safe.ok(1)) as number;
  return n + 1;
});
```

**Lazy, always.** Nothing in the body runs until `run`, and each `run` runs the body
again — which is what makes retry (chapter 6) work.
