# 7 · Performance, and where this fits

Measured with the harness in `benchmark/` (`bun run bench`): ten scenarios, both lanes
build the program per call, five trials, a win counts only when the min–max ranges do
not overlap.

| scenario | safe-ts | Effect `runPromiseExit` | verdict |
|---|---|---|---|
| two steps, success | 567 ns | 697 ns | safe-ts |
| ten pure steps | 631 ns | 796 ns | safe-ts |
| throw → typed error | 1009 ns | 1164 ns | safe-ts |
| four concurrent children | 921 ns | 1104 ns | safe-ts |
| ten boundary steps | 1070 ns | 1129 ns | noise |
| twenty boundary steps | 1594 ns | 1587 ns | noise |
| one async step | 907 ns | 937 ns | noise |

**The honest summary:** we win on fixed costs (the run boundary, pure steps, the
throw mapping, bounded fan-out) and tie on per-step cost. Effect's fiber dispatch is
about as fast as our direct loop; its runtime does more and costs more to start.

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
