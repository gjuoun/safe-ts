# safe-ts — 教程

八章，包含 Scheduler 的实际使用指南。所有代码块都能对该库编译通过（`bun run docs:check`）。

1. [值：一个 Safe](./01-the-value.md)
2. [边界：`Safe.call`](./02-the-boundary.md)
3. [编排：`Safe.try`](./03-sequencing.md)
4. [错误即数据](./04-errors.md)
5. [一定会执行的清理](./05-cleanup.md)
6. [并发、超时、重试、取消](./06-concurrency.md)
7. [性能，以及适合的场景](./07-performance.md)
8. [Scheduler 与取消：实用指南](./08-scheduler.md)
9. [内部实现：原本写在代码注释里的语义](./09-internals.md)

English: [../en/README.md](../en/README.md)。参考资料在
[README](../../README.md) 与 [examples](../../examples/)；实测数据在
[`benchmark/`](../../benchmark)。
