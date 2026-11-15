# 7 · 并发、超时、重试、取消

这里的每个组合子都由 `exec` 加一个 signal、一个定时器或一批任务构成。没有 fiber、没有
调度循环 —— 调度交给平台的事件循环。

## `Safe.all` —— 并发、保序

```ts
import { Runtime, Safe } from "safe-ts";

const fetchDoc = (id: string) => Safe.call(async () => `doc:${id}`);

const exit = await Runtime.run(Safe.all([fetchDoc("a"), fetchDoc("b")]));
console.log(exit); // { _tag: "success", value: ["doc:a", "doc:b"] }
```

第一个 `fail` 或 `die` 会中断兄弟任务，并成为结果。

## `Safe.race` —— 谁先结束用谁

```ts
import { Runtime, Safe } from "safe-ts";

const slow = Safe.call(async (s) => {
  await s.sleep(200);
  return "slow";
});
const fast = Safe.call(async () => "fast");

console.log(await Runtime.run(Safe.race([slow, fast]))); // { _tag: "success", value: "fast" }
```

输家会被中断；忽略 signal 的输家仍会跑完。

## `Safe.forEach` —— 有上限的并发

```ts
import { Runtime, Safe } from "safe-ts";

const work = (n: number) => Safe.call(async () => n * 2);

const exit = await Runtime.run(Safe.forEach([1, 2, 3], work, { concurrency: 2 }));
console.log(exit); // { _tag: "success", value: [2, 4, 6] }
```

## 超时

```ts
import { Outcome, Runtime, Safe } from "safe-ts";

const slow = Safe.call(async (s) => {
  await s.sleep(500);
  return "late";
});

console.log((await Runtime.run(Safe.timeout(slow, 10)))._tag); // "interrupt"
const mapped = await Runtime.run(Safe.timeout(slow, 10, () => "too_slow" as const));
console.log(Outcome.isFail(mapped) ? mapped.error : mapped._tag); // "too_slow"
```

超时是 `interrupt` —— 与边界中断同一个分支 —— 除非你把它映射掉。

## 重试

```ts
import { Runtime, Safe } from "safe-ts";

let attempts = 0;
const flaky = Safe.call(
  () => {
    attempts++;
    if (attempts < 3) throw new Error("not yet");
    return attempts;
  },
  () => "unavailable" as const,
);

console.log(await Runtime.run(Safe.retry(flaky, { attempts: 3, delayMs: 5 })));
// { _tag: "success", value: 3 }
```

只有已声明的 `fail` 会被重试：缺陷是 bug，中断表示有人要求停下。每次尝试都有自己的
作用域，所以失败尝试的资源会在下一次开始前释放。

## 取消

```ts
import { Runtime, Safe } from "safe-ts";

const program = Safe.try(function* () {
  yield* Safe.sleep(500);
  return "never";
});

const exit = await Runtime.run(program, { signal: AbortSignal.timeout(10) });
console.log(exit._tag); // "interrupt"
```

在回调内部，协作靠 `Scheduler`：`s.sleep(ms)` 等待 run 的 signal，`s.onCancel(fn)`
登记该停止什么，`s.signal` 直接传给需要 signal 的 API。
