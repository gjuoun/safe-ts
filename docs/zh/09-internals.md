# 9 · 内部实现：原本写在代码注释里的语义

这一章收编了"代码内零注释"规则生效前留在源码里的设计说明。改 `src/` 之前先读它。

## `Safe.call` 是唯一的边界

一个 Safe 能做的所有事都收进一个构造器：

- `Safe.call(fn)` — `fn` 在 `run` 时执行（lazy，每次 run 都重跑）。未声明
  `mapErr` 时抛异常是 `die` —— 一个缺陷，永远不是声明过的失败。
- `Safe.call(fn, mapErr)` — 声明了 `mapErr`：throw 或 rejection 变成
  `fail(mapErr(thrown))`。
- `Safe.call` 拒绝 generator function：编排是 `Safe.try` 的职责，在这里接受一个会
  悄悄走错路。
- 传给 `fn` 的 scheduler 是 run 自己的 `CallScheduler`：sleep、定时器和
  `onCancel` 都绑在 run 的 signal 和 clock 上，取消不会给每次调用多挂一个
  listener。

`call` 上的 `sealed = true` 表示它的 promise 已经把 rejection 转成了 `Outcome`，
`exec` 不必再包一层 —— 热路径的省法。

## `Safe.try`：编排和隐式 scope

`Safe.try` 运行 generator body：

- `yield* safe` 驱动这个 Safe 并把值送回；非 success 的 Outcome 停住 body。
- `yield safe`（裸 yield）是热路径写法 —— 跳过 `yield*` 的委托循环，每步约省
  26 ns；值以 `TNext` 回来，需要强转。
- body 是 lazy 的：`run` 之前什么都不执行，每次 `run` 重跑 —— 这正是 `retry`
  依赖的东西。

**隐式 scope：** body 在一个新 `Scope` 里跑，body 产出 Outcome 时这个 scope 关闭
—— 成功、失败、缺陷、中断都算。`Safe.defer` 登记到这里，所以 `try` 里的
`defer` 在 body 出边界时结算 —— `using` 块的边界。这是刻意的语义选择：
资源的寿命恰好等于用它那段代码的寿命。

## `Safe.defer`：唯一的清理原语

两个 overload，一条规则 —— "最后一个参数是出边界要跑的东西"：

```ts
import { Safe } from "@gjuoun/safe-ts";

declare const metrics: { end(tag: string): void };
declare const open: () => Safe<{ close(): void }, never>;

const program = Safe.try(function* () {
  yield* Safe.defer((outcome) => metrics.end(outcome._tag));
  const conn = yield* Safe.defer(open(), (c, outcome) => c.close());
  return conn;
});
```

**为什么需要两参形态：** 如果 acquire 和登记是两个 yield，abort 插中间会留下一个
没人管的活资源。两参形态把 `acquire` 放在 `NEVER_ABORTED` 下跑，并在同一步里登记
release —— 要么根本没拿到，要么拿到且释放已登记。登记先于 interrupt 检查：已经中止的
run 也会把 finalizer 记下来。

`Pipe.defer(fn)` 是同一个想法绑在单个 Safe 上 —— 不需要 scope，那个 Safe 一出结果
就触发。

## `Outcome`：四臂，一种分类

`success | fail | die | interrupt` —— 工作所有可能的结束方式，扁平、不嵌套。
`die` 是缺陷：没人声明过的 throw。`interrupt` 是取消。yield 返回 `Outcome` 本身
（而不是再包一层）每步省一次分配。

## Scope 和 finalizer

`Scope` 收集 `Finalizer`，在 `close` 时 LIFO 执行：

- 每个 finalizer 都执行，哪怕前面的抛了异常。
- finalizer 抛异常会把 `success` 变成 `die`；其他结局保留自己的原因。
- `run` 建 root `Scope`；`Safe.try` 每个 body 建一个；`retry` 每次 attempt 建
  一个 —— 失败 attempt 的资源在下一次开始前就释放。

## 中断：协作式，不是强杀

`uninterruptible` 给区域屏蔽 run 的 signal；`interruptible` 在里面恢复。屏蔽期间
的 abort 在区域退出时被看到 —— 结局变 `interrupt`，`die` 保持 `die`。停止是
signal 协作：body 不听 signal 就继续跑，直到它自己落地。

## driver

`drive` 泵 generator：同步步骤走同步循环，一旦某个步骤的 promise 是真的就切到异步
延续。某个步骤非 success 或 signal 已中止时调 `it.return()` —— body 里每个 `finally`
都会跑，async 的也会被等 —— 然后经 `closedOutcome` 收口（throw 的 finally 只在 body
成功时才算缺陷）。
