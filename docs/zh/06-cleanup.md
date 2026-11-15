# 6 · 一定会执行的清理

`Safe.acquireRelease` 把资源和它的释放配对。释放会在**每一种**退出方式下执行：成功、
失败、缺陷、中断。

```ts
import { Runtime, Safe } from "safe-ts";

const openDb = () =>
  Safe.acquireRelease(
    Safe.call(() => ({ open: true })),
    (_db, exit) => console.log(`release after ${exit._tag}`),
  );

const program = Safe.try(function* () {
  const db = yield* openDb();
  return yield* Safe.err("boom" as const);
});

console.log((await Runtime.run(program))._tag); // 先 release after fail，再 "fail"
```

`Safe.scoped` 给这段工作一个自己的作用域，它一退出就关闭：

```ts
import { Runtime, Safe } from "safe-ts";

const work = Safe.scoped(
  Safe.try(function* () {
    yield* Safe.acquireRelease(Safe.ok("conn"), () => console.log("closed"));
    return "done";
  }),
);

console.log(await Runtime.run(work)); // 先 closed，再 success
```

## `ensuring`：没有资源的清理

```ts
import { Runtime, Safe } from "safe-ts";

const timed = Safe.ensuring(Safe.ok(1), (exit) => console.log(`always: ${exit._tag}`));
console.log(await Runtime.run(timed)); // 先 always: success，再 success
```

## 规则

- 释放顺序是**后进先出**。
- 释放抛异常会把成功变成 `die`；失败则保留自己的错误。
- 释放可以是异步的，也可以是 generator，并可以在其中 `yield*` 服务。
- run 被中断时释放仍然执行 —— 这正是登记它的意义。

```ts
import { Runtime, Safe } from "safe-ts";

const slow = Safe.scoped(
  Safe.try(function* () {
    yield* Safe.acquireRelease(Safe.ok("conn"), () => console.log("closed"));
    yield* Safe.sleep(500);
    return "never";
  }),
);

const exit = await Runtime.run(slow, { signal: AbortSignal.timeout(10) });
console.log(exit._tag); // "interrupt"，而且 "closed" 已经打印
```
