# safe-ts

[![npm version](https://img.shields.io/npm/v/@gjuoun/safe-ts.svg)](https://www.npmjs.com/package/@gjuoun/safe-ts)

Typed errors and cancellable effects for TypeScript — without a fiber runtime.

📖 [Docs](./docs/README.md) — [English](./docs/en/README.md) · [中文](./docs/zh/README.md) ·
[examples](./examples) · [benchmark](./benchmark)

## Install

```sh
npm install @gjuoun/safe-ts   # Node ≥ 20.3
bun add @gjuoun/safe-ts       # Bun
```

<details>
<summary><h3>Quick start</h3></summary>

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
- **`Safe.defer`** — one cleanup primitive: `defer(fn)` registers a finalizer on the
  enclosing `Safe.try` scope; `defer(acquire, release)` runs acquire uninterruptibly
  and pairs the resource atomically. `Pipe.defer` is the per-Safe twin.
- **Cancellation, `timeout`, `retry`, `all`, `race`, `forEach`** — built from
  `exec` plus a signal, a timer or a batch. No fiber, no scheduler loop.

</details>

## Measured

Twelve timed scenarios, both libraries building the program per call, five trials, a
win only when the min–max ranges do not overlap (`bun run bench`, ns/call):

| scenario | safe-ts | Effect | ratio | verdict |
|---|---|---|---|---|
| success | 640 | 670 | 0.95 | noise |
| recover | 831 | 880 | 0.94 | noise |
| earlyExit | 685 | 612 | 1.12 | effect wins |
| pure10 | 665 | 789 | 0.84 | safe-ts wins |
| chain10 | 1100 | 1224 | 0.90 | safe-ts wins |
| chain20 | 1692 | 1888 | 0.90 | safe-ts wins |
| thrown | 1071 | 1115 | 0.96 | noise |
| asyncInSync | 1063 | 956 | 1.11 | effect wins |
| concurrency | 997 | 1153 | 0.86 | safe-ts wins |
| cleanup | 785 | 1092 | 0.72 | safe-ts wins |
| retryFlaky | 2279 | 6019 | 0.38 | safe-ts wins |
| retry_timeout | 12340 | 8694 | 1.42 | effect wins |

`timeoutBound` and `delayWait` are skipped — they sleep on a real timer, so the wall
clock measures the sleep, not the library. safe-ts wins on fixed costs (the run
boundary, pure steps, bounded fan-out, retries) and loses the one scenario where a
retry has to outlive a timeout. Cold import 13 ms against Effect's 76 ms; 60 KB of
source with no runtime dependencies.

## License

MIT