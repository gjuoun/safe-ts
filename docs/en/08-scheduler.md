# 8 · Scheduler and cancellation: practical guide

`Safe.call` gives its callback a `Scheduler` for **this call**. You do not
construct it or abort it directly. To cancel from outside, the caller owns an
`AbortController` and passes its signal to `Runtime.run`:

```text
Cancel button → controller.abort() → Runtime.run({ signal })
                                    → Safe.call(s) → s.signal / s.onCancel
```

`Scheduler` is a **type-only** public interface, not a runtime class you can
instantiate. These are its four public members:

| Member | When to use it |
|---|---|
| `s.signal` | Pass to an HTTP/DB API that accepts `AbortSignal`. Prefer this. |
| `s.onCancel(fn)` | Register a synchronous stop action when the client only has `cancel()` or similar. Returns a function to unregister it. |
| `s.sleep(ms)` | Wait using the run's clock; cancellation stops the wait. |
| `s.now()` | Read the same clock used by that run, including a manual test clock. |

`s.signal.aborted` tells you whether cancellation has already been requested.
There is no separate `s.aborted`, and `finish`/`settlePending` are internal
settlement methods, not public Scheduler operations.

## 1. Cancel a browser HTTP request

For a page with `<button id="load">Load</button>`,
`<button id="cancel">Cancel</button>` and `<pre id="status"></pre>`:

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const getUser = Safe.call(
  async (s) => {
    const response = await fetch("/api/users/u1", { signal: s.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  },
  (error) => `HTTP failed: ${String(error)}`,
);

const load = document.querySelector<HTMLButtonElement>("#load")!;
const cancel = document.querySelector<HTMLButtonElement>("#cancel")!;
const status = document.querySelector<HTMLElement>("#status")!;
let active: AbortController | undefined;

load.addEventListener("click", async () => {
  if (active) return;
  const controller = new AbortController();
  active = controller;
  status.textContent = "Loading...";
  const result = await Runtime.run(getUser, { signal: controller.signal });
  active = undefined;
  status.textContent =
    result._tag === "success" ? result.value
    : result._tag === "fail" ? result.error
    : result._tag === "interrupt" ? "Cancelled"
    : "Unexpected error";
});

cancel.addEventListener("click", () => active?.abort());
```

Create a new controller per request. The button calls `abort()` **outside**;
`Safe.call` receives the run's signal **inside**. Since `fetch` already
understands `AbortSignal`, do not add an `onCancel` callback. A non-2xx HTTP
response does not make `fetch` reject, so check `response.ok` yourself.
The mapper turns an ordinary HTTP error into `fail`; an abort is `interrupt`,
not a mapped HTTP failure.

## 2. A database client that cannot take a signal

If a query returns a handle with `cancel()` but no `signal` option, register
its cancellation immediately after starting it:

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
    (error) => `DB failed: ${String(error)}`,
  );

const controller = new AbortController();
const pending = Runtime.run(findUser("u1"), { signal: controller.signal });
controller.abort();
console.log((await pending)._tag); // "interrupt"
```

`onCancel` registers an action **before** an abort; it does not initiate the
abort. If the signal is already aborted at registration time, it invokes the
action immediately. If the run started aborted, `Safe.call` never starts the
query at all. The returned function can unregister an action when its resource
is no longer in flight. Registered actions and the library's abort listener
are cleared when the call settles, so aborting a completed call does not run
its old callbacks.

The action is synchronous and is **not** a general cleanup hook. If it throws
while cancelling an in-flight call, the call ends as `die` rather than silently
swallowing the cleanup defect.
For cleanup that must also happen on success or failure, or must be awaited,
use [`Pipe.ensuring` or `Pipe.acquireRelease`](./05-cleanup.md).

## 3. One failed request cancels four siblings

`Safe.all` starts the calls together. It keeps the first `fail` or `die` as
the **batch** result and aborts its remaining in-flight siblings:

```ts
import { Runtime, Safe } from "@gjuoun/safe-ts";

const getUser = (id: string) =>
  Safe.call(
    async (s) => {
      const response = await fetch(`/api/users/${id}`, { signal: s.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
    (error) => `request failed: ${String(error)}`,
  );

const result = await Runtime.run(
  Safe.all(["a", "b", "c", "d", "e"].map(getUser)),
);
```

If `c` fails while the others are pending, the batch returns **c's failure**;
the other calls are cancelled (`interrupt`), **not** converted into four
copies of c's error. Already-completed requests cannot be undone. Cancelling
is cooperative: if an underlying API ignores the signal, its work may
continue even after its Safe reports interruption. For independent results
without sibling cancellation, use `Safe.allSettled`. See the
[runnable five-request example](../../examples/06-parallel-requests.ts).

## 4. Test time without waiting in real time

`s.sleep()` and `s.now()` use the clock supplied to `Runtime.run`; the
default is real time. A manual clock controls waits in tests:

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

`Safe.delay`, `Pipe.timeout` deadlines and `Pipe.retry` waits also use the
run's clock. It cannot fast-forward real network or DB requests, nor waits
that explicitly use `setTimeout` or `Clocks.real` instead of the injected
clock. For more cases, run
`bun run examples/04-scheduler.ts`.

## Cancellation boundaries

- An ordinary rejection becomes `fail(mapErr(error))` if a mapper was supplied,
  otherwise `die`. Aborts are normally `interrupt`, even if the underlying
  client rejects with an `AbortError`; `mapErr` does not turn them into a
  typed failure.
- `Safe.call` can report `interrupt` without stopping an API that ignores
  cancellation. Pass `s.signal` or use `s.onCancel` to stop underlying work.
- A call that returns synchronously is already finished: a later abort
  cannot undo its result. `onCancel` is not a substitute for resource
  finalizers; see [chapter 5](./05-cleanup.md).
- `Safe.race` and `Pipe.timeout` may create their own child signals. Always
  pass the **received** `s.signal` to your client rather than a controller
  captured outside, so local timeouts and sibling cancellations also reach it.

See [chapter 6](./06-concurrency.md) for all concurrency combinators and
[the HTTP/DB example](../../examples/04-scheduler.ts) for a runnable walkthrough.
