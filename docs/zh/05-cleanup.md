# 5 · 一定会执行的清理

`Safe.defer` 是唯一的清理原语。它登记到所在的 scope —— 每个 `Safe.try` 都自带
一个 —— 清理在**每一种**退出方式下执行：成功、失败、缺陷、中断。

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const program = Safe.try(function* () {
  const conn = yield* Safe.defer(
    Safe.call(() => ({ open: true })),
    (_db, exit) => console.log(`release after ${exit._tag}`),
  );
  return yield* Safe.err("boom" as const);
});

console.log((await Runtime.run(program))._tag);
// 先 release after fail，再 "fail"
```

两个参数的形态把 acquire 不可中断地跑完，然后把资源和它的释放原子配对 ——
要么资源根本没被拿到，要么拿到且释放已登记。清理在 body 的 scope 关闭时
结算：`using` 块的边界。

## `Safe.defer(fn)`：没有资源的清理

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const timed = Safe.try(function* () {
  yield* Safe.defer((exit) => console.log(`always: ${exit._tag}`));
  return yield* Safe.ok(1);
});
console.log(await Runtime.run(timed)); // 先 always: success，再 success
```

## `Pipe.defer`：绑在单个 Safe 上的清理

pipe 版本挂在单个 Safe 上，它一出结果立刻触发 —— 不涉及 scope，也不需要
`try`：

```ts
import { Pipe, type Safe } from "@gjuoun/safe-ts";

declare const fetchUser: (id: string) => Safe<{ id: string }, never>;
declare const metrics: { end(tag: string): void };

const work = fetchUser("u1").pipe(
  Pipe.defer((exit) => metrics.end(exit._tag)),
);
```

## `Pipe.scoped`：跨 `try` 的共享窗口

`Safe.try` 已经给自己的 `defer` 提供了作用域。只有当多个 `Safe.try` 里的
资源要共享同一个生命周期时才需要 `Pipe.scoped`：

```ts
import { Pipe, Safe } from "@gjuoun/safe-ts";

declare const openA: () => Safe<{ close(): void }, never>;
declare const inner: () => Safe<number, never>;

const shared = Safe.try(function* () {
  const a = yield* Safe.defer(openA(), c => c.close());
  yield* inner();   // inner 的 defer 已结；a 还活着
}).pipe(Pipe.scoped);
```

## 规则

- 释放顺序是**后进先出**。
- 释放抛异常会把成功变成 `die`；失败则保留自己的错误。
- 释放可以是异步的，也可以是 generator，并可以在其中 `yield*` 服务。
- run 被中断时释放仍然执行 —— 这正是登记它的意义。

`s.onCancel(fn)` 不同：它只在**取消进行中的操作**时运行，例如调用数据库客户端的
`cancel()`；正常成功或失败时不会运行，而且回调是同步的。每一种退出方式都要做的
清理请使用 `Safe.defer` 或 `Pipe.defer`。详见
[Scheduler 与取消](./08-scheduler.md)。

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const slow = Safe.try(function* () {
  yield* Safe.defer(Safe.ok("conn"), () => console.log("closed"));
  yield* Safe.delay(500);
  return "never";
});

const exit = await Runtime.run(slow, { signal: AbortSignal.timeout(10) });
console.log(exit._tag); // "interrupt"，而且 "closed" 已经打印
```
