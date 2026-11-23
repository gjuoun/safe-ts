# safe-ts — engineering contract

A lazy `Safe<A, E>` effect system for TypeScript. Read this before changing code —
a change that breaks a gate below is rejected even when it works.

## Gates — one command, before every commit

```bash
bun run check    # guardrail: typecheck → biome → no-comments → test → docs:check
```

`scripts/guardrail.ts` runs all five gates in order and exits non-zero on the
first failure. Never judge a gate through a pipe — redirect to a log and check
the exit code.

| gate | tool | what it guards |
|---|---|---|
| typecheck | `tsc --noEmit` | type safety, no emit |
| biome | `biome check .` | lint + format (single `biome.json`) |
| no-comments | `scripts/no-comments.ts` | zero comments in source (see below) |
| test | `bun test` | behavior, 118 tests |
| docs:check | `scripts/doc-check.ts` | every ```ts block in docs/ + README compiles |

## No comments in source

`.ts` files carry no comments — not `//`, not `/* */`, not `/** */`. Design
intent lives in `ARCHITECTURE.md` (root) and `docs/en|zh/09-internals.md`.
`scripts/no-comments.ts` enforces this via the TypeScript scanner; strings and
template literals cannot false-positive. Suppression comments (`@ts-expect-error`,
`biome-ignore`) count as comments — rewrite the code instead.

## Layout

- `src/` — the library, nine modules, one entry `index.ts`
- `docs/en`, `docs/zh` — nine-chapter tutorial, compiled by `docs:check`
- `examples/` — runnable, compiled by `docs:check` like the docs
- `test/` — `bun test`; `test/types/` is type-asserted via `assertType`
- `benchmark/` — safe-ts vs Effect lanes; `bun run bench`
- `scripts/` — `guardrail.ts`, `no-comments.ts`, `doc-check.ts`, `build.ts`

## What the library is

- One lazy `Safe<A, E>`, one boundary `Safe.call`, one sequencer `Safe.try`
- One cleanup primitive `Safe.defer`; `Pipe.defer` is the per-Safe twin
- `Pipe` is seven ops: `timeout, retry, defer, scoped, catchTag,
  uninterruptible, interruptible`
- `Outcome` is four arms: `success | fail | die | interrupt`
- No fibers, no scheduler loop, no R channel — dependencies are constructor args

## Non-negotiables

- Comments go to `ARCHITECTURE.md` / `docs/`, never to `.ts` files
- `exec` and `isThenable` are internal — userland composes `Safe → Safe`, it
  does not intercept Outcomes
- `Safe.try` owns a scope per body; `Pipe.scoped` is for windows shared across
  `try` bodies
- Never `biome check --write --unsafe`
