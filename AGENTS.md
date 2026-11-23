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
| biome | `biome check .` | lint + format (single `biome.json`), plus the `no-as` plugin |
| no-as | `biome check .` + `rules/no-as.grit` | zero `as` assertions in `examples/` and `benchmark/` |
| no-comments | `scripts/no-comments.ts` | zero comments in source (see below) |
| test | `bun test` | behavior, 118 tests |
| docs:check | `scripts/doc-check.ts` | every ```ts block in docs/ + README compiles |

## No comments in source

`.ts` files carry no comments — not `//`, not `/* */`, not `/** */`. Design
intent lives in `ARCHITECTURE.md` (root) and `docs/en|zh/09-internals.md`.
`scripts/no-comments.ts` enforces this via the TypeScript scanner; strings and
template literals cannot false-positive. Suppression comments (`@ts-expect-error`,
`biome-ignore`) count as comments — rewrite the code instead.

## No `as` assertions in userland

`examples/` and `benchmark/` carry no `as`. A cast asserts a type the compiler cannot verify, and the
teaching surface is exactly where that habit propagates: those files show the boundary they actually need —
a decoder, a checked index, a declared return type — instead of silencing the checker. `as const` is allowed;
it narrows literals rather than overriding them.

`rules/no-as.grit` enforces it as a Biome GritQL plugin, not a separate runner, so the violation shows up in
`biome check`, in the editor, and in this gate at once. Two details are load-bearing: `as const` is exempted
with the string comparator `$T <: "const"` (a node snippet never matches it), and `src/` plus `test/` are
exempted by a `$filename` predicate — the library's own type plumbing legitimately needs assertions. Biome
overrides cannot scope a plugin per file, so the allowlist lives inside the rule. The rule is vendored here
rather than imported from the workspace's `@workspace/guardrail` because this repo publishes standalone.

## Layout

- `src/` — the library, nine modules, one entry `index.ts`
- `docs/en`, `docs/zh` — nine-chapter tutorial, compiled by `docs:check`
- `examples/` — runnable, compiled by `docs:check` like the docs
- `test/` — `bun test`; `test/types/` is type-asserted via `assertType`
- `benchmark/` — safe-ts vs Effect lanes; `bun run bench`
- `scripts/` — `guardrail.ts`, `no-comments.ts`, `doc-check.ts`, `build.ts`
- `rules/` — `no-as.grit`, the Biome plugin the `biome` gate runs

## What the library is

- One lazy `Safe<A, E>`, one boundary `Safe.call`, one sequencer `Safe.try`
- One cleanup primitive `Safe.defer`; `Pipe.defer` is the per-Safe twin
- `Pipe` is seven ops: `timeout, retry, defer, scoped, catchTag,
  uninterruptible, interruptible`
- `Outcome` is four arms: `success | fail | die | interrupt`
- No fibers, no scheduler loop, no R channel — dependencies are constructor args

## Non-negotiables

- Comments go to `ARCHITECTURE.md` / `docs/`, never to `.ts` files
- `examples/` and `benchmark/` stay free of `as` — `as const` excepted
- `exec` and `isThenable` are internal — userland composes `Safe → Safe`, it
  does not intercept Outcomes
- `Safe.try` owns a scope per body; `Pipe.scoped` is for windows shared across
  `try` bodies
- Never `biome check --write --unsafe`
