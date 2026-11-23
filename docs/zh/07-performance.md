# 7 · 性能，以及它适合什么场景

数据来自仓库里的 `benchmark/`（`bun run bench`）：十二个场景，两边都在每次调用时
构建程序，五次试验，只有 min–max 区间不重叠才算"赢"。数字单位是 ns/call。

| 场景 | safe-ts | Effect | 比值 | 结论 |
|---|---|---|---|---|
| success | 640 | 670 | 0.95 | 噪声 |
| recover | 831 | 880 | 0.94 | 噪声 |
| earlyExit | 685 | 612 | 1.12 | effect wins |
| pure10 | 665 | 789 | 0.84 | safe-ts wins |
| chain10 | 1100 | 1224 | 0.90 | safe-ts wins |
| chain20 | 1692 | 1888 | 0.90 | safe-ts wins |
| thrown | 1071 | 1115 | 0.96 | 噪声 |
| asyncInSync | 1063 | 956 | 1.11 | effect wins |
| concurrency | 997 | 1153 | 0.86 | safe-ts wins |
| cleanup | 785 | 1092 | 0.72 | safe-ts wins |
| retryFlaky | 2279 | 6019 | 0.38 | safe-ts wins |
| retry_timeout | 12340 | 8694 | 1.42 | effect wins |

**诚实的结论：** 固定成本赢（run 边界、纯值步骤、有界并发、重试），输的地方正是
Effect 的 fiber runtime 为我们没有的东西付了钱 —— 一个要活过 timeout 的重试，以及
我们的 generator driver 不需要的 early-exit 路径。冷启动 import 13 ms 对 Effect 的
76 ms；60 KB 源码，零运行时依赖。

| | safe-ts | Effect |
|---|---|---|
| 冷启动 import | 14 ms | 77 ms |
| 安装体积 | 60 KB 源码，0 依赖 | 62 MB |
| 单个程序的类型检查 | 65 ms | 87 ms |

## 什么时候用它

- 服务或脚本里，"这个调用可能产生哪些错误"很重要，而且答案应该在类型里。
- 代码要在几个月后被别人 —— 或一个 agent —— 读懂。
- 想要取消、有界并发和清理，但不想引入一个 runtime。

## 什么时候别用

- 需要 fiber、大规模结构化并发、stream、schema 或 tracing —— 那是 Effect 的地盘，
  在那里它值得这个重量。
- 程序只有三行且不会失败：老老实实 `try`/`catch` 更诚实。

## 故意不做的

`fork`/`join`、优先级、yield 策略：它们都需要一个调度循环，而这个库不拥有它。调度交给
JS 引擎；我们负责描述工作，并分类它是怎么结束的。
