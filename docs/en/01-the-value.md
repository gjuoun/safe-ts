# 1 · The value: a Safe

A `Safe<A, E, R>` is a **description of work**, not work. Nothing runs until you call
`Runtime.run`, and each run executes the description again.

- `A` — what it succeeds with
- `E` — the errors you declared for it
- `R` — the services it still needs (chapter 5)

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const answer = Safe.ok(42);
console.log(await Runtime.run(answer)); // { _tag: "success", value: 42 }
```

Running never throws and never rejects. The result is a flat `Outcome` with four arms:

| arm | meaning |
|---|---|
| `success` | it worked, `value` is there |
| `fail` | a declared error, `error` is there |
| `die` | something threw that nobody declared — a bug |
| `interrupt` | someone aborted the run |

```ts
import { Outcome, Runtime, Safe } from "@gjuoun/safe-ts";

const exit = await Runtime.run(Safe.err("not_found"));
if (Outcome.isFail(exit)) console.log(exit.error); // "not_found"
```

**Why lazy.** A description can be retried, raced, run with a different signal, or
never run at all — and a failure path you never exercise costs nothing.
