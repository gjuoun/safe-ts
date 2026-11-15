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
- **Cancellation, scopes, `timeout`, `retry`, `all`, `race`, `forEach`** — built from
  `exec` plus a signal, a timer or a batch. No fiber, no scheduler loop.

</details>

## Measured

Twelve timed scenarios, both libraries building the program per call, five trials, a
win only when the min–max ranges do not overlap (`bun run bench`, ns/call):

| scenario | safe-ts | Effect | ratio | verdict |
|---|---|---|---|---|
| success | 715 | 770 | 0.93 | noise |
| recover | 893 | 956 | 0.93 | noise |
| earlyExit | 714 | 713 | 1.00 | noise |
| pure10 | 734 | 893 | 0.82 | safe-ts wins |
| chain10 | 1176 | 1414 | 0.83 | safe-ts wins |
| chain20 | 1859 | 2230 | 0.83 | safe-ts wins |
| thrown | 1158 | 1341 | 0.86 | noise |
| asyncInSync | 1039 | 1056 | 0.98 | noise |
| concurrency | 1107 | 1221 | 0.91 | noise |
| cleanup | 946 | 1120 | 0.84 | safe-ts wins |
| retryFlaky | 2312 | 6418 | 0.36 | safe-ts wins |
| retry_timeout | 13473 | 9689 | 1.39 | effect wins |

`timeoutBound` and `delayWait` are skipped — they sleep on a real timer, so the wall
clock measures the sleep, not the library. safe-ts wins on fixed costs (the run
boundary, pure steps, bounded fan-out, retries) and loses the one scenario where a
retry has to outlive a timeout. Cold import 13 ms against Effect's 76 ms; 60 KB of
source with no runtime dependencies.

## License

MIT