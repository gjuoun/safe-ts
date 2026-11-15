# 4 · 错误即数据

先声明一份错误目录：每个变体一个工厂，payload 由你决定。

```ts
import { Errors } from "@gjuoun/safe-ts";

const userError = Errors.define({
  not_found: (id: string) => ({ message: `no user ${id}`, id }),
  unavailable: (cause: unknown) => ({ message: "user service down", cause }),
});
```

工厂的返回值就是 payload，而**键就是标签** —— 没有额外注入的 `code`，也没有未声明的
`message`。使用它们会让 `E` 成为一个联合类型：

```ts
import { Errors, Runtime, Safe } from "@gjuoun/safe-ts";

const userError = Errors.define({
  not_found: (id: string) => ({ message: `no user ${id}`, id }),
});

const load = (id: string) =>
  Safe.try(function* () {
    if (id !== "u1") return yield* Safe.err(userError.not_found(id));
    return { name: "ada" };
  });

console.log(await Runtime.run(load("u2")));
// { _tag: "fail", error: { not_found: { message: "no user u2", id: "u2" } } }
```

## 恢复其中一个变体

`catchTag` 匹配一个键并把 payload 交给你；其它分支原样穿过。

```ts
import { Errors, Pipe, Runtime, Safe } from "@gjuoun/safe-ts";

const userError = Errors.define({
  not_found: (id: string) => ({ message: `no user ${id}`, id }),
  unavailable: () => ({ message: "down" }),
});

const load = (id: string) =>
  Safe.try(function* () {
    if (id !== "u1") return yield* Safe.err(userError.not_found(id));
    return { name: "ada" };
  });

const tolerant = load("u2").pipe(
  Pipe.catchTag("not_found", (payload: { id: string }) =>
    Safe.ok({ name: `guest-${payload.id}` }),
  ),
);

console.log(await Runtime.run(tolerant));
// { _tag: "success", value: { name: "guest-u2" } }
```

## 给函数真正会返回的变体命名

一个方法很少会产生整个 catalog。把变体在 catalog 旁边命名一次，签名就能准确说出
"它只可能这样失败" —— 而且编译器会盯着，因为 `Safe` 在 `E` 上协变：函数体多产生一个
签名里没写的变体，就不再编译。

```ts
import { Errors, Safe, type FailureOf } from "@gjuoun/safe-ts";

const userError = Errors.define({
  not_found: (id: string) => ({ status: 404, message: `no user ${id}`, id }),
});

// 每个变体一行，就写在 catalog 旁边。
export type UserNotFound = FailureOf<typeof userError, "not_found">;

declare const load: (id: string) => Safe<{ name: string }, UserNotFound>;
```

`FailureOf` 收的是 **catalog**，值就是工厂的返回类型 —— 带 tag 的那层 `{ not_found: { … } }`，
也就是运行时真正产生的形状。反过来索引联合（`ErrorsOf<typeof userError>["not_found"]`）
只会得到不带 tag 的 payload，赋不进 `Safe` 的失败通道。

整个联合仍然可用：`ErrorsOf<typeof userError>` —— 组合根一次性登记所有域时才需要它。

## 渲染给人看

```ts
import { Errors } from "@gjuoun/safe-ts";

const userError = Errors.define({
  not_found: (id: string) => ({ message: `no user ${id}`, id }),
});

console.log(Errors.render(userError.not_found("u9")));
// { code: "not_found", message: "no user u9" }
```

**经验法则：** 已声明的错误是可以分支的数据；缺陷（`die`）是应该出现在日志里、而不是
出现在 `catchTag` 里的 bug。
