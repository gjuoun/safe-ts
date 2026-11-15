# safe-ts

Typed errors and cancellable effects for TypeScript — without a fiber runtime.

```ts
import { Errors, Runtime, Safe } from "@gjuoun/safe-ts";

const userError = Errors.define({
  not_found: (id: string) => ({ message: `no user ${id}`, id }),
});

class UserRepo {
  constructor(private readonly rows: Record<string, { id: string; name: string }>) {}
  find(id: string) {
    return this.rows[id];
  }
}

const repo = new UserRepo({ u1: { id: "u1", name: "ada" } });

const getUser = (id: string) =>
  Safe.try(function* () {
    const user = repo.find(id);
    if (!user) return yield* Safe.err(userError.not_found(id));
    return user;
  });

await Runtime.run(getUser("u1"));
// { _tag: "success", value: { id: "u1", name: "ada" } }
```

- **`Safe<A, E>`** — a lazy description of work: what it succeeds with, what it can
  fail with. Nothing else to thread — dependencies are constructor arguments, so a
  missing one is a compile error at the call site.
- **`Safe.call(fn, mapErr?)`** — the only boundary. Declare a mapper and a throw becomes
  `fail(mapErr(thrown))`; omit it and the throw is a `die` — a defect, never something
  you declared.
- **`Outcome`** — flat, four arms: `success`, `fail`, `die`, `interrupt`. `run` never
  throws and never rejects.
- **Cancellation, scopes, `timeout`, `retry`, `all`, `race`, `forEach`** — built from
  `exec` plus a signal, a timer or a batch. No fiber, no scheduler loop.

## Cancel an HTTP request

The caller passes a signal to `Runtime.run`; `Safe.call` gives its callback a
`Scheduler` whose `s.signal` is passed to an API such as `fetch`. Cancel from
outside with `controller.abort()`. There is no need to construct a Scheduler:

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const getUser = Safe.call(
  async (s) => {
    const response = await fetch("/api/users/u1", { signal: s.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  },
  (error) => String(error),
);

const controller = new AbortController();
const pending = Runtime.run(getUser, { signal: controller.signal });
controller.abort(); // e.g. in a Cancel button's click handler
console.log((await pending)._tag); // "interrupt"
```

If a client cannot accept a signal but has `cancel()`, register it with
`s.onCancel(() => query.cancel())`. `Scheduler` is a **type-only** public interface:
`signal`, `onCancel`, `sleep`, `now`. See the [Scheduler and cancellation guide](./docs/en/08-scheduler.md)
([中文](./docs/zh/08-scheduler.md)) for button handlers, database clients,
concurrent requests, and virtual time in tests.

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

Runnable examples: [HTTP and DB cancellation](./examples/04-scheduler.ts) ·
[five concurrent requests](./examples/06-parallel-requests.ts) ·
[`examples/`](./examples). [`benchmark/`](./benchmark) compares against Effect.

## Measured

Ten scenarios, both libraries building the program per call, five trials, a win only when
the ranges do not overlap (`bun run bench`): safe-ts is ahead on fixed costs — the run
boundary, pure steps, throw mapping, bounded fan-out — and level on per-step cost. Cold
import 14 ms against Effect's 77 ms; 60 KB of source with no runtime dependencies.

## License

MIT