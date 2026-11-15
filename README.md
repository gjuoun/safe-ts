# safe-ts

Typed errors and dependency-aware effects for TypeScript — without a fiber runtime.

```ts
import { Errors, Runtime, Safe, Services } from "@gjuoun/safe-ts";

const userError = Errors.define({
  not_found: (id: string) => ({ message: `no user ${id}`, id }),
});

class UserRepo {
  static *init() {
    return new UserRepo();
  }
  find(id: string) {
    return id === "u1" ? { id, name: "ada" } : undefined;
  }
}

const getUser = (id: string) =>
  Safe.try(function* () {
    const repo = yield* Services.get(UserRepo);
    const user = repo.find(id);
    if (!user) return yield* Safe.err(userError.not_found(id));
    return user;
  });

await Runtime.run(Services.provide(getUser("u1"), [UserRepo]));
// { _tag: "success", value: { id: "u1", name: "ada" } }
```

- **`Safe<A, E, R>`** — a lazy description of work. `R` names the services it still
  needs, so a missing service is a compile error, not a runtime `undefined`.
- **`Safe.call(fn, mapErr?)`** — the only boundary. Declare a mapper and a throw becomes
  `fail(mapErr(thrown))`; omit it and the throw is a `die` — a defect, never something
  you declared.
- **`Outcome`** — flat, four arms: `success`, `fail`, `die`, `interrupt`. `run` never
  throws and never rejects.
- **Cancellation, scopes, `timeout`, `retry`, `all`, `race`, `forEach`** — built from
  `exec` plus a signal, a timer or a batch. No fiber, no scheduler loop.

## Install

```sh
bun add @gjuoun/safe-ts
# or: npm i @gjuoun/safe-ts
```

ESM only, zero runtime dependencies, one bundle and one `.d.ts`. Node ≥ 20.3 (or Bun).

## Docs

[Tutorial, eight chapters](./docs/README.md) — [English](./docs/en/README.md) ·
[中文](./docs/zh/README.md). Every code block in the docs and in this README is compiled
by `bun run docs:check`.

[`examples/`](./examples) runs standalone · [`bench/`](./bench) compares against Effect.

## Measured

Ten scenarios, both libraries building the program per call, five trials, a win only when
the ranges do not overlap (`bun run bench`): safe-ts is ahead on fixed costs — the run
boundary, pure steps, throw mapping, bounded fan-out — and level on per-step cost. Cold
import 14 ms against Effect's 77 ms; 60 KB of source with no runtime dependencies.

## License

MIT