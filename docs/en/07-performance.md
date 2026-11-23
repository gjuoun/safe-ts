# 7 · Performance, and where this fits

Measured with the harness in `benchmark/` (`bun run bench`): twelve scenarios, both
lanes build the program per call, five trials, a win counts only when the min–max
ranges do not overlap. Numbers are ns/call.

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

**The honest summary:** we win on fixed costs (the run boundary, pure steps, bounded
fan-out, retries) and lose where Effect's fiber runtime pays for what we don't have —
a retry that has to outlive a timeout, and an early-exit path its generator driver
doesn't need. Cold import 13 ms against Effect's 76 ms; 60 KB of source with no
runtime dependencies.

| | safe-ts | Effect |
|---|---|---|
| cold import | 14 ms | 77 ms |
| install | 60 KB source, 0 dependencies | 62 MB |
| typecheck of one program | 65 ms | 87 ms |

## When to reach for it

- A service or a script where "which error can this produce" matters and the
  answer should be in the type.
- Code that has to be read by someone — or by an agent — months later.
- You want cancellation, backpressure and cleanup without adopting a runtime.

## When not to

- You need fibers, structured concurrency at scale, streams, schemas or tracing —
  that is Effect, and it is worth its weight there.
- The program is three lines and cannot fail: a plain `try`/`catch` is honest.

## What is deliberately out

`fork`/`join`, priorities, a yield policy: each needs a scheduling loop the library
does not own. The JS engine schedules; we describe work and classify how it stopped.
