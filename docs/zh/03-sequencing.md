# 3 · 编排：`Safe.try`

`Safe.try` 接收一个 generator 函数体。`yield*` 一个 `Safe` 拿到它的值；失败会在那里
终止函数体，并成为结果。

```ts
import { Runtime, Safe } from "safe-ts";

const parse = (text: string) =>
  Safe.call(() => JSON.parse(text) as { name: string }, (): "bad_json" => "bad_json");

const program = Safe.try(function* () {
  const config = yield* parse('{"name":"demo"}');
  if (!config.name) return yield* Safe.err("missing_name" as const);
  return config;
});

console.log(await Runtime.run(program));
// { _tag: "success", value: { name: "demo" } }
```

提前失败仍会执行 `finally`，所以照常写的清理是保留的：

```ts
import { Runtime, Safe } from "safe-ts";

const traced = Safe.try(function* () {
  try {
    return yield* Safe.err("boom" as const);
  } finally {
    console.log("cleanup runs");
  }
});

console.log((await Runtime.run(traced))._tag); // 先打印 cleanup runs，再是 "fail"
```

## 函数体保持同步

同步函数体也能 yield 异步的 Safe —— 编排靠 `yield*`，不是 `await`：

```ts
import { Runtime, Safe } from "safe-ts";

const slow = Safe.call(async () => "loaded");

const program = Safe.try(function* () {
  const value = yield* slow; // 不需要 async 关键字
  return value.toUpperCase();
});

console.log(await Runtime.run(program)); // { _tag: "success", value: "LOADED" }
```

`async function*` 函数体也能用，但运行时成本大约翻倍（第 8 章）：每个 `next()` 都变成
promise。优先用同步函数体。

## 热路径用 `yield` 而不是 `yield*`

普通 `yield` 把 `Safe` 直接交给 driver，跳过 `yield*` 的委托循环 —— 每步大约便宜 26 ns。
返回值类型是 `TNext`，需要一次类型断言：

```ts
import { Runtime, Safe } from "safe-ts";

const program = Safe.try(function* () {
  const n = (yield Safe.ok(1)) as number;
  return n + 1;
});
```

**永远是惰性的。** 函数体在 `run` 之前不执行任何东西，而且每次 `run` 都重新执行 ——
这正是重试（第 7 章）能成立的原因。
