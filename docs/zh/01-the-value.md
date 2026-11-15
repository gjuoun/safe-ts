# 1 · 值：一个 Safe

`Safe<A, E, R>` 是**工作的描述**，不是工作本身。调用 `Runtime.run` 之前什么都不执行，
每一次 run 都会重新执行这份描述。

- `A` — 成功时的值
- `E` — 你为它声明的错误
- `R` — 它还需要的服务（第 5 章）

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const answer = Safe.ok(42);
console.log(await Runtime.run(answer)); // { _tag: "success", value: 42 }
```

run 从不抛异常、也不 reject。结果是扁平的 `Outcome`，四个分支：

| 分支 | 含义 |
|---|---|
| `success` | 成功，`value` 就是结果 |
| `fail` | 已声明的错误，`error` 就是错误 |
| `die` | 没人声明的异常 —— 是 bug |
| `interrupt` | 有人中断了这次 run |

```ts
import { Outcome, Runtime, Safe } from "@gjuoun/safe-ts";

const exit = await Runtime.run(Safe.err("not_found"));
if (Outcome.isFail(exit)) console.log(exit.error); // "not_found"
```

**为什么是惰性的。** 一份描述可以被重试、被赛跑、被换一个 signal 执行，也可以永远不执行 ——
而你从不走的失败路径，成本为零。
