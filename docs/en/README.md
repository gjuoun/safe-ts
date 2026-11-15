# safe-ts — tutorial

Eight chapters, including a hands-on Scheduler guide. Every code block compiles against
the library (`bun run docs:check`).

1. [The value: a Safe](./01-the-value.md)
2. [The boundary: `Safe.call`](./02-the-boundary.md)
3. [Sequencing: `Safe.try`](./03-sequencing.md)
4. [Errors as data](./04-errors.md)
5. [Cleanup that always runs](./05-cleanup.md)
6. [Concurrency, timeouts, retries, cancellation](./06-concurrency.md)
7. [Performance, and where this fits](./07-performance.md)
8. [Scheduler and cancellation: practical guide](./08-scheduler.md)

Chinese version: [../zh/README.md](../zh/README.md). Reference material lives in the
[README](../../README.md) and the [examples](../../examples/); measured numbers in
[`benchmark/`](../../benchmark).
