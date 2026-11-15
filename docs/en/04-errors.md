# 4 · Errors as data

You declare a catalog: one factory per variant, the payload is yours.

```ts
import { Errors } from "@gjuoun/safe-ts";

const userError = Errors.define({
  not_found: (id: string) => ({ message: `no user ${id}`, id }),
  unavailable: (cause: unknown) => ({ message: "user service down", cause }),
});
```

A factory's return value is the payload, and the **key is the tag** — there is no
injected `code` and no undeclared `message`. Using them makes `E` a union:

```ts
import { Errors, Runtime, Safe } from "@gjuoun/safe-ts";

const userError = Errors.define({
  not_found: (id: string) => ({ message: `no user ${id}`, id }),
});

const load = (id: string) =>
  Safe.try(function* () {
    if (id !== "u1") return yield* Safe.err(userError.not_found(id));
    return { name: "ada" };
  });

console.log(await Runtime.run(load("u2")));
// { _tag: "fail", error: { not_found: { message: "no user u2", id: "u2" } } }
```

## Recovering one variant

`catchTag` matches one key and hands you its payload; every other arm passes through.

```ts
import { Errors, Pipe, Runtime, Safe } from "@gjuoun/safe-ts";

const userError = Errors.define({
  not_found: (id: string) => ({ message: `no user ${id}`, id }),
  unavailable: () => ({ message: "down" }),
});

const load = (id: string) =>
  Safe.try(function* () {
    if (id !== "u1") return yield* Safe.err(userError.not_found(id));
    return { name: "ada" };
  });

const tolerant = load("u2").pipe(
  Pipe.catchTag("not_found", (payload: { id: string }) =>
    Safe.ok({ name: `guest-${payload.id}` }),
  ),
);

console.log(await Runtime.run(tolerant));
// { _tag: "success", value: { name: "guest-u2" } }
```

## Naming the variants a function can actually return

A method rarely produces a whole catalog. Name the variants once, next to the
catalog, then the signature says exactly what can go wrong — and the compiler keeps
it honest, because `Safe` is covariant in `E`: produce one more variant than the
signature names and the body stops compiling.

```ts
import { Errors, Safe, type FailureMap, type FailureOf } from "@gjuoun/safe-ts";

const userError = Errors.define({
  not_found: (id: string) => ({ status: 404, message: `no user ${id}`, id }),
});

// A map from tag to the tagged error. Index it to keep the tag in the signature.
export type UserErrors = FailureMap<typeof userError>;
declare const find: (id: string) => Safe<{ name: string }, UserErrors["not_found"]>;

// Or name the variant once and use the name.
export type UserNotFound = FailureOf<typeof userError, "not_found">;
declare const load: (id: string) => Safe<{ name: string }, UserNotFound>;
```

Both spellings are the *tagged arm* `{ not_found: { … } }` — the shape a run produces.
Indexing the union instead (`ErrorsOf<typeof userError>["not_found"]`) gives the payload
without its tag, which is not assignable to a `Safe` failure; `FailureMap` and `FailureOf`
both take the catalog and derive from the factory, so they cannot drift from the run.

## Rendering one for a human

```ts
import { Errors } from "@gjuoun/safe-ts";

const userError = Errors.define({
  not_found: (id: string) => ({ message: `no user ${id}`, id }),
});

console.log(Errors.render(userError.not_found("u9")));
// { code: "not_found", message: "no user u9" }
```

**Rule of thumb:** a declared error is data you can branch on; a defect (`die`) is a
bug you want to see in a log, not in a `catchTag`.
