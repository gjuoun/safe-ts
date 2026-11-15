# 5 · 服务：`R` 槽

服务就是普通 class。`static *init` 返回实例，并可以用 `yield* Services.get(Dep)` 说明
自己的依赖。

```ts
import { Runtime, Safe, Services } from "@gjuoun/safe-ts";

class Logger {
  static *init() {
    return new Logger();
  }
  info(message: string) {
    console.log(`info: ${message}`);
  }
}

class UserRepo {
  constructor(private readonly logger: Logger) {}
  static *init() {
    return new UserRepo(yield* Services.get(Logger));
  }
  find(id: string) {
    this.logger.info(`find ${id}`);
    return { id, name: "ada" };
  }
}

const program = Safe.try(function* () {
  const repo = yield* Services.get(UserRepo);
  return repo.find("u1");
});
```

这个程序的类型说明它还需要 `UserRepo`：`Safe<{id,name}, never, UserRepo>`。`Runtime.run`
拒绝 `R` 不是 `never` 的 `Safe`，所以**少给服务是编译错误**，而不是运行时查到 `undefined`。

```ts
import { Runtime, Safe, Services } from "@gjuoun/safe-ts";

class Config {
  constructor(readonly dbUrl: string) {}
  static *init() {
    return new Config("sqlite://app.db");
  }
}

const program = Safe.try(function* () {
  const config = yield* Services.get(Config);
  return config.dbUrl;
});

console.log(await Runtime.run(Services.provide(program, [Config])));
// { _tag: "success", value: "sqlite://app.db" }
```

## 两种提供方式

| | 适用场景 |
|---|---|
| `Services.provide(safe, [A, B])` | 为**一次** run 构建这些 class |
| `Runtime.make([A, B])` | 构建一次、跨多次 run 复用，最后 `dispose()` |

```ts
import { Runtime } from "@gjuoun/safe-ts";

class Db {
  static *init() {
    return new Db();
  }
  *dispose() {
    console.log("db: closed");
  }
}

const runtime = Runtime.make([Db]);
// …runtime.run(program) 可以调用任意多次…
await runtime.dispose(); // 按构建的逆序关闭每个实例
```

## 现成实例

不是由 class 构建的值走同一条路 —— `Services.instance(Class, value)`。它既是测试用的 fake，
也是组合根把配置传进来的方式：

```ts
import { Runtime, Safe, Services } from "@gjuoun/safe-ts";

class Config {
  constructor(readonly dbUrl: string) {}
  static *init() {
    return new Config("sqlite://app.db");
  }
}

const program = Safe.try(function* () {
  return (yield* Services.get(Config)).dbUrl;
});

const wired = Services.provide(program, [
  Services.instance(Config, new Config("postgres://real.db")),
]);

console.log((await Runtime.run(wired))._tag); // "success"
```

**服务里不读 `process.env`。** 组合根读一次环境，再把值传进来；读全局变量的服务无法测试
也无法复用。
