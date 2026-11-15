# 5 · 一定会执行的清理

`acquireRelease` 把资源和它的释放配对。释放会在**每一种**退出方式下执行：成功、
失败、缺陷、中断。它是一个 `Safe → Safe` 工厂 —— 和其他包装器一样，在 `pipe` 里
包住一个 Safe。

```ts
import { Pipe, Runtime, Safe } from "@gjuoun/safe-ts";

const openDb = () =>
  Safe.call(() => ({ open: true })).pipe(
    Pipe.acquireRelease((_db: { open: boolean }, exit) =>
      console.log(`release after ${exit._tag}`),
    ),
  );

const program = Safe.try(function* () {
  const db = yield* openDb();
  return yield* Safe.err("boom" as const);
});

console.log((await Runtime.run(program))._tag); // 先 release after fail，再 "fail"
```

`scoped` 给这段工作一个自己的作用域，它一退出就关闭 —— 它是组合子常量，pipe 时
不需要括号：

```ts
import { Pipe, Runtime, Safe } from "@gjuoun/safe-ts";

const work = Safe.try(function* () {
  yield* Safe.ok("conn").pipe(Pipe.acquireRelease(() => console.log("closed")));
  return "done";
}).pipe(Pipe.scoped);

console.log(await Runtime.run(work)); // 先 closed，再 success
```

## `ensuring`：没有资源的清理

```ts
import { Pipe, Runtime, Safe } from "@gjuoun/safe-ts";

const timed = Safe.ok(1).pipe(Pipe.ensuring((exit) => console.log(`always: ${exit._tag}`)));
console.log(await Runtime.run(timed)); // 先 always: success，再 success
```

## 规则

- 释放顺序是**后进先出**。
- 释放抛异常会把成功变成 `die`；失败则保留自己的错误。
- 释放可以是异步的，也可以是 generator，并可以在其中 `yield*` 服务。
- run 被中断时释放仍然执行 —— 这正是登记它的意义。

`s.onCancel(fn)` 不同：它只在**取消进行中的操作**时运行，例如调用数据库客户端的
`cancel()`；正常成功或失败时不会运行，而且回调是同步的。每一种退出方式都要做的
清理请使用 `ensuring` 或 `acquireRelease`。详见
[Scheduler 与取消](./08-scheduler.md)。

```ts
import { Pipe, Runtime, Safe } from "@gjuoun/safe-ts";

const slow = Safe.try(function* () {
  yield* Safe.ok("conn").pipe(Pipe.acquireRelease(() => console.log("closed")));
  yield* Safe.delay(500);
  return "never";
}).pipe(Pipe.scoped);

const exit = await Runtime.run(slow, { signal: AbortSignal.timeout(10) });
console.log(exit._tag); // "interrupt"，而且 "closed" 已经打印
```
