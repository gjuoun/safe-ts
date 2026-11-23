# 8 · Scheduler 与取消：实用指南

每次 `Safe.call` 都会把**本次调用**的 `Scheduler` 交给回调。你不需要构造它，也
不通过它主动发起取消。要从外部取消，调用方持有 `AbortController`，把 signal
交给 `Runtime.run`：

```text
Cancel 按钮 → controller.abort() → Runtime.run({ signal })
                                    → Safe.call(s) → s.signal / s.onCancel
```

`Scheduler` 对外只是**类型接口**，不是可供构造的运行时类。公开成员只有四个：

| 成员 | 何时使用 |
|---|---|
| `s.signal` | 传给接受 `AbortSignal` 的 HTTP/DB API，优先选择。 |
| `s.onCancel(fn)` | 客户端只有 `cancel()` 等方法时，注册同步停止动作；返回值可以注销该动作。 |
| `s.sleep(ms)` | 用本次运行的时钟等待；取消会停止等待。 |
| `s.now()` | 读取本次运行的时钟，包括测试用的手动时钟。 |

可以通过 `s.signal.aborted` 检查是否已请求取消。没有单独的 `s.aborted`；
`finish` 和 `settlePending` 是内部结算方法，不属于对外的 Scheduler 接口。

## 1. 在网页上取消 HTTP 请求

假设页面上有 `<button id="load">加载</button>`、
`<button id="cancel">取消</button>` 和 `<pre id="status"></pre>`：

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const getUser = Safe.call(
  async (s) => {
    const response = await fetch("/api/users/u1", { signal: s.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  },
  (error) => `HTTP 请求失败：${String(error)}`,
);

const load = document.querySelector<HTMLButtonElement>("#load")!;
const cancel = document.querySelector<HTMLButtonElement>("#cancel")!;
const status = document.querySelector<HTMLElement>("#status")!;
let active: AbortController | undefined;

load.addEventListener("click", async () => {
  if (active) return;
  const controller = new AbortController();
  active = controller;
  status.textContent = "加载中…";
  const result = await Runtime.run(getUser, { signal: controller.signal });
  active = undefined;
  status.textContent =
    result._tag === "success" ? result.value
    : result._tag === "fail" ? result.error
    : result._tag === "interrupt" ? "已取消"
    : "意外错误";
});

cancel.addEventListener("click", () => active?.abort());
```

每次请求创建新的 controller：按钮在**外部**调用 `abort()`，`Safe.call` 在**内部**
接收这次运行的 signal。`fetch` 已支持 `AbortSignal`，无需再注册 `onCancel`。
`fetch` 遇到非 2xx 响应也不会自动 reject，因此要自己检查 `response.ok`。
正常的 HTTP 错误经过 mapper 成为 `fail`；取消则是 `interrupt`，不是 HTTP 失败。

## 2. 不接受 signal 的数据库客户端

如果查询返回带 `cancel()` 的句柄，却不接受 `signal` 参数，在启动查询后立即
注册取消动作：

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

declare const db: {
  queryUser(id: string): { result: Promise<string>; cancel(): void };
};

const findUser = (id: string) =>
  Safe.call(
    (s) => {
      const query = db.queryUser(id);
      s.onCancel(() => query.cancel());
      return query.result;
    },
    (error) => `数据库错误：${String(error)}`,
  );

const controller = new AbortController();
const pending = Runtime.run(findUser("u1"), { signal: controller.signal });
controller.abort();
console.log((await pending)._tag); // "interrupt"
```

`onCancel` 是在 abort **之前注册**动作，不负责发起 abort。如果注册时 signal
已经 aborted，动作会立即执行；如果运行开始前就已 aborted，则 `Safe.call`
根本不会开始查询。`onCancel` 的返回函数可在资源提前结束时注销动作。调用结束
后，注册的动作及库管理的 abort 监听会被清除，所以事后再 abort 不会执行旧回调。

这个动作是同步的，**不是**通用清理钩子。如果它在取消进行中的调用时抛异常，
结果是 `die`，不会悄悄吞掉清理缺陷。成功或失败时也需要清理、或者清理需要等待完成时，
使用 [`Safe.defer` 或 `Pipe.defer`](./05-cleanup.md)。

## 3. 五个并发请求，其中一个失败

`Safe.all` 一起启动这些调用。第一个 `fail` 或 `die` 成为**整个批次**的结果，
其余仍在进行中的调用会收到 abort：

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const getUser = (id: string) =>
  Safe.call(
    async (s) => {
      const response = await fetch(`/api/users/${id}`, { signal: s.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
    (error) => `请求失败：${String(error)}`,
  );

const result = await Runtime.run(
  Safe.all(["a", "b", "c", "d", "e"].map(getUser)),
);
```

假设 `c` 先失败，而其他请求仍在进行，整个批次保留 **c 的失败**；其他调用被
取消（`interrupt`），**不会**变成四份相同的错误。已完成的请求无法撤销。
取消是协作式的：底层 API 若忽略 signal，即使 Safe 已报告中断，底层工作仍可能
继续运行。想要每个独立结果、失败不取消其他任务，则使用 `Safe.allSettled`。
参见[五请求可运行示例](../../examples/06-parallel-requests.ts)。

## 4. 在测试中模拟时间

`s.sleep()` 与 `s.now()` 使用 `Runtime.run` 传入的时钟，默认是真实时间。
测试时可以手动推进时钟，不必真的等待：

```ts
import { Clocks, Runtime, Safe } from "@gjuoun/safe-ts";

const { clock, advance } = Clocks.manual();
const work = Safe.call(async (s) => {
  const started = s.now();
  await s.sleep(1_000);
  return s.now() - started;
});

const pending = Runtime.run(work, { clock });
advance(1_000);
console.log(await pending); // { _tag: "success", value: 1000 }
```

`Safe.delay`、`Pipe.timeout` 的截止时间和 `Pipe.retry` 的等待也使用这次运行
的时钟。但它不能快进真实 HTTP/DB 请求，也不能快进自行使用 `setTimeout` 或
写死 `Clocks.real` 的等待。更多例子可以运行
`bun run examples/04-scheduler.ts`。

## 取消时需要知道的边界

- 普通的 reject：提供 mapper 时是 `fail(mapErr(error))`，否则是 `die`。
  取消通常是 `interrupt`；即使底层客户端抛出 `AbortError`，也不会由 `mapErr`
  映射为类型化失败。
- `Safe.call` 能报告 `interrupt`，但无法自动停止忽略取消的底层 API；要传
  `s.signal` 或用 `s.onCancel` 才能真正停止底层工作。
- 同步返回的调用已经结束，之后再 abort 不能撤销结果。`onCancel` 不能替代
  资源的 finalizer；参见[第 5 章](./05-cleanup.md)。
- `Safe.race` 和 `Pipe.timeout` 可能创建自己的子 signal。传给客户端的应该是
  **回调拿到的** `s.signal`，而不是从外部捕获的 controller；这样局部超时和
  兄弟任务的取消也能传到客户端。

其他并发组合子见[第 6 章](./06-concurrency.md)；
[HTTP/DB 可运行示例](../../examples/04-scheduler.ts)展示了完整过程。
