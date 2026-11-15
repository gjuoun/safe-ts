# 2 · 边界：`Safe.call`

所有可能抛异常的东西都从**一个**函数进入。`Safe.call` 执行你的回调并分类它如何结束：

- 给了 mapper → 抛异常或 reject 变成 `fail(mapErr(thrown))`
- 没给 → 抛出来的是 `die`：缺陷，不是你声明的错误

```ts
import { Runtime, Safe } from "safe-ts";

const parse = (text: string) =>
  Safe.call(
    () => JSON.parse(text) as { name: string },
    (): "bad_json" => "bad_json",
  );

console.log(await Runtime.run(parse('{"name":"demo"}')));
// { _tag: "success", value: { name: "demo" } }
console.log(await Runtime.run(parse("{")));
// { _tag: "fail", error: "bad_json" }
```

异步遵循同一条规则，reject 与 throw 的分类完全一致：

```ts
import { Runtime, Safe } from "safe-ts";

const fetchUser = (id: string) =>
  Safe.call(
    async () => {
      const res = await fetch(`/users/${id}`);
      return (await res.json()) as { name: string };
    },
    (): "unavailable" => "unavailable",
  );

const exit = await Runtime.run(fetchUser("u1"));
console.log(exit._tag); // "success" | "fail" | "die" | "interrupt"
```

回调拿到一个 `Scheduler`，取消能力在那里（第 7 章）：

```ts
import { Safe } from "safe-ts";

const wait = Safe.call(async (s) => {
  await s.sleep(50);
  return s.aborted ? "stopped" : "done";
});
```

**一条规则，没有例外。** 会抛异常的函数在代码边缘被包进 `Safe.call`；进去之后，
一切都是 `Safe`。
