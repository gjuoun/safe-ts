# 5 · Services: the `R` slot

A service is a plain class. `static *init` returns the instance, and it may name its
own dependencies with `yield* Services.get(Dep)`.

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

The program's type says it still needs a `UserRepo`: `Safe<{id,name}, never, UserRepo>`.
`Runtime.run` refuses a `Safe` whose `R` is not `never`, so **a missing service is a
compile error**, not a runtime lookup that returns `undefined`.

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

## Two ways to provide

| | when |
|---|---|
| `Services.provide(safe, [A, B])` | build the classes for **one** run |
| `Runtime.make([A, B])` | build once and reuse across runs, then `dispose()` |

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
// …runtime.run(program) as many times as you like…
await runtime.dispose(); // closes every instance, last-built first
```

## A ready instance

A value that is not built by a class enters the same way — `Services.instance(Class, value)`.
That is the test fake, and it is also how the composition root passes configuration in:

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

**No `process.env` inside a service.** The composition root reads the environment
once and hands the value in; a service that reads globals cannot be tested or reused.
