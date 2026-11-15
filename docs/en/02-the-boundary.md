# 2 · The boundary: `Safe.call`

Everything that can throw enters through **one** function. `Safe.call` runs your
callback and classifies how it stopped:

- declare a mapper → a throw or rejection becomes `fail(mapErr(thrown))`
- omit it → the throw is a `die`: a defect, not something you declared

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

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

The same rule covers async work. A rejection is classified exactly like a throw:

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

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

The callback receives a `Scheduler` — cancellation lives there (chapter 6):

```ts
import { Safe } from "@gjuoun/safe-ts";

const wait = Safe.call(async (s) => {
  await s.sleep(50);
  return "done";
});
```

**One rule, no exceptions.** If a function can throw, it is wrapped in `Safe.call`
at the edge of your code; inside, everything is a `Safe`.
