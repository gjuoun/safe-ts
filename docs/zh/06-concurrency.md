# 6 · 并发、超时、重试、取消

这里的每个包装器都是 `Safe → Safe` 工厂 —— `exec` 加一个 signal、一个定时器或
一条车道，没有 fiber —— 它们在 `pipe` 里与 Safe 相遇：

```ts
import { Pipe, Safe } from "@gjuoun/safe-ts";

const fetch: Safe<number, string> = Safe.ok(1);
const policy = { attempts: 3, delayMs: 10 };

// timeout 包住整个重试循环
Safe.pipe(fetch, Pipe.retry(policy), Pipe.timeout(30_000));

// timeout 包住每一次尝试；策略看到的是那个 typed fail
Safe.pipe(fetch, Pipe.timeout(2_000, () => "timeout" as const), Pipe.retry(policy));
```

两种写法是同一个 fold：`Safe.pipe(safe, op1, op2)` 与方法形式 `safe.pipe(op1, op2)`。
首选变参形式 —— 类型逐个 op 往下流；单个 op 也可以放进数组，`Safe.pipe(safe, [op])`。
两者都是惰性的：`Runtime.run` 之前什么都不会跑。

## `Safe.all` —— 并发、保序

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const fetchDoc = (id: string) => Safe.call(async () => `doc:${id}`);

const exit = await Runtime.run(Safe.all([fetchDoc("a"), fetchDoc("b")]));
console.log(exit); // { _tag: "success", value: ["doc:a", "doc:b"] }
```

第一个 `fail` 或 `die` 会中断兄弟任务，并成为**整个批次**的结果。其他进行中的
调用是被中断，而不是也变成相同的类型化失败；已经完成的调用不能撤销。客户端必须
响应 `s.signal`（或注册 `s.onCancel`），底层工作才会停下。五个 HTTP 请求的完整
讲解见 [Scheduler 与取消](./08-scheduler.md)及
[可运行示例](../../examples/06-parallel-requests.ts)。
`Safe.allSettled` 则按输入顺序返回每一个 `Outcome`，失败也不会取消其他任务。

## `Safe.race` —— 谁先结束用谁

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const slow = Safe.call(async (s) => {
  await s.sleep(200);
  return "slow";
});
const fast = Safe.call(async () => "fast");

console.log(await Runtime.run(Safe.race([slow, fast]))); // { _tag: "success", value: "fast" }
```

输家会被中断；忽略 signal 的输家仍会跑完。`{ awaitLosers: true }` 让赢家只在
所有输家真正结束后才返回 —— "run 返回了" 意味着 "工作停了"。

## `Safe.forEach` —— 有上限的并发

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const work = (n: number) => Safe.call(async () => n * 2);

const exit = await Runtime.run(Safe.forEach([1, 2, 3], work, { concurrency: 2 }));
console.log(exit); // { _tag: "success", value: [2, 4, 6] }
```

`concurrency: n` 时一个滑动窗口保持 n 条车道在飞 —— 一条车道一结束就拿起下一个
元素，单个慢元素不再拖住后面的波次。第一个非成功结果中断其余；不设上限时退化为
`Safe.all`。

## 超时

```ts
import { Outcome, Pipe, Runtime, Safe } from "@gjuoun/safe-ts";

const slow = Safe.call(async (s) => {
  await s.sleep(500);
  return "late";
});

console.log((await Runtime.run(slow.pipe(Pipe.timeout(10))))._tag); // "interrupt"
const mapped = await Runtime.run(slow.pipe(Pipe.timeout(10, () => "too_slow" as const)));
console.log(Outcome.isFail(mapped) ? mapped.error : mapped._tag); // "too_slow"
```

超时是 `interrupt` —— 与边界中断同一个分支 —— 除非你把它映射掉。deadline 在
run 的时钟上等待，所以 `Clocks.manual()` 可以把它虚拟化。

## 重试，以及驱动它的 Policy

```ts
import { Pipe, Runtime, Safe } from "@gjuoun/safe-ts";

let attempts = 0;
const flaky = Safe.call(
  () => {
    attempts++;
    if (attempts < 3) throw new Error("not yet");
    return attempts;
  },
  () => "unavailable" as const,
);

console.log(await Runtime.run(flaky.pipe(Pipe.retry({ attempts: 3, delayMs: 5 }))));
// { _tag: "success", value: 3 }
```

策略是一个值 —— `(state) => ms | undefined` —— 在 `Policy` 命名空间里组装，
方式和包装器在 `Safe.pipe` 里组装相同：

```ts
import { Policy } from "@gjuoun/safe-ts";

// 指数退避，每步封顶 10 秒 —— min 取较短的那个
Policy.min([Policy.exponential(250), Policy.spaced(10_000)]);

// 指数、加抖动、最多 6 次 —— 一个列表，不用嵌套
Policy.pipe(Policy.exponential(250), [
  Policy.modifyDelay((d) => d * 0.8 + Math.random() * 0.4 * d),
  Policy.while((s) => s.attempt <= 6),
]);
```

两条规则保住代数不咬人：**gate 放 `max`，cap 放 `min`** —— `min` 只要任何
分支继续就继续，把 gate 放那里会被悄悄忽略 —— 而 `while`/`modifyDelay` 是变换器
不是策略，单独喂给 `retry` 是编译错误。

只有已声明的 `fail` 会被重试：缺陷是 bug，中断表示有人要求停下。每次尝试有自己的
作用域，失败尝试的资源在下一次开始前释放 —— 这一点走在了 Effect 前面。

## 取消与可中断性

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const program = Safe.try(function* () {
  yield* Safe.delay(500);
  return "never";
});

const exit = await Runtime.run(program, { signal: AbortSignal.timeout(10) });
console.log(exit._tag); // "interrupt"
```

### Scheduler 的控制

`Runtime.run(safe, { signal })` 接收调用方传入的 signal；每次 `Safe.call` 的回调
都得到这次运行的 `Scheduler` 视图。支持 `AbortSignal` 的客户端直接使用
`s.signal`，否则注册 `s.onCancel(() => client.cancel())`。`s.sleep` 和 `s.now`
使用这次运行的时钟。你不需要构造 Scheduler：公开的 `Scheduler` 只是类型接口，
结算细节在库内部。

取消通常产生 `interrupt`，而不是类型化的 `fail`。取消是协作式的：底层请求如果
忽略取消，即使 Safe 已经结算，它仍可能继续运行。关于 Cancel 按钮、DB 客户端、
`Safe.all` 失败传导和手动时钟测试，请阅读独立的
[Scheduler 与取消指南](./08-scheduler.md)。

`uninterruptible` 和 `interruptible` 是区域组合子 —— 组合子常量，不用加
括号 —— 分别用于屏蔽 deadline 和把区域重新暴露给它：

```ts
import { Pipe, Safe } from "@gjuoun/safe-ts";

declare const critical: Safe<number, never>;
declare const acquire: Safe<{ close(): void }, never>;
declare const close: (r: { close(): void }) => void;

// 该区域不可被切断；deadline 在下一步被观察到。
Safe.pipe(critical, [Pipe.uninterruptible]);

// 在被屏蔽的区域里，`interruptible` 还原真实 signal ——
// `acquireRelease` 的 acquire 阶段是被屏蔽的，所以这就是 Effect 的 `restore`。
Safe.pipe(acquire, Pipe.interruptible, Pipe.acquireRelease(close));
```