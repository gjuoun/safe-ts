// examples/05-concurrency-and-cleanup.ts — pipes, policies, cleanup.
//
// One doc-fetch service assembled the way the library intends: the work is a
// `Safe.try` generator, and everything that wraps it — a retry policy, a
// deadline, a per-request scope — is a `Pipe.*` op in one list. The retry
// policy is itself a value assembled in `Policy.*`. No statics, no second
// spelling: `Safe.pipe` folds `Safe → Safe`, `Policy.pipe` folds `Policy →
// Policy`, and cleanup (`Safe.defer`, `Pipe.defer`, `Pipe.scoped`) runs LIFO on
// every exit — success, fail, die and interrupt.
//
//   bun run examples/05-concurrency-and-cleanup.ts
import { type Outcome, Pipe, Policy, Runtime, Safe } from "../src/index.ts";

// A flaky store: two failures, then it answers. A typed failure, not a throw —
// so `Pipe.retry` can see it and a `Policy` can decide what to do about it.
const store = new Map([
	["a", "doc:a"],
	["b", "doc:b"],
	["flaky", "doc:flaky"],
]);
let calls = 0;
const fetchDoc = (id: string) =>
	Safe.call(
		async (s) => {
			calls += 1;
			await s.sleep(20);
			const doc = store.get(id);
			// The store drops the first two calls for "flaky" — a typed failure.
			if (doc === undefined || (id === "flaky" && calls < 3)) throw new Error(`no ${id}`);
			return doc;
		},
		() => `fetch_failed:${id}` as const,
	);

// --- The policy is a value ---
// Exponential backoff at 10 ms, jittered ±20%, and a hard stop after 4
// attempts — the three needs of a real retry composed in one `Policy.pipe`.
const jitter = (d: number) => d * 0.8 + Math.random() * 0.4 * d;
const flakyPolicy = Policy.pipe(Policy.exponential(10), [
	Policy.modifyDelay(jitter),
	Policy.while((s) => s.attempt <= 4),
]);

// --- The wrapper ops are a list ---
// `Pipe.retry` consumes the policy; `Pipe.timeout` bounds the *whole* loop.
// Swap the order and the timeout would bound each attempt instead.
const fetchFlaky = (id: string) => fetchDoc(id).pipe(Pipe.retry(flakyPolicy), Pipe.timeout(1_000));

// A resource that always reports when it is released — and why.
const open = (name: string) =>
	Safe.defer(
		Safe.call(() => {
			console.log(`open ${name}`);
			return name;
		}),
		(_r: string, exit) => console.log(`close ${name} (${exit._tag})`),
	);

const show = <A, E>(exit: Outcome<A, E>): string => {
	if (exit._tag === "success") return `ok: ${JSON.stringify(exit.value)}`;
	return exit._tag === "fail" ? `fail: ${JSON.stringify(exit.error)}` : exit._tag;
};

// 1. A retry policy drives a flaky fetch to success.
console.log("— retry + policy —");
calls = 0;
console.log(show(await Runtime.run(fetchFlaky("flaky"))), `(${calls} calls)`);

// 2. A deadline bounds the whole loop: the policy's waits observe the run's
// signal, so a 30 ms budget inside a 50 ms minimum sleep ends as `interrupt`.
console.log("— timeout bounds the loop —");
const deadline = fetchDoc("zzz").pipe(Pipe.retry(Policy.spaced(500)), Pipe.timeout(30));
console.log(show(await Runtime.run(deadline)));

// 3. Bounded fan-out with a policy per item: `Safe.forEach` keeps a sliding
// window, each item runs its own retry+timeout.
console.log("— forEach over pipes —");
const bulk = (ids: readonly string[]) =>
	Safe.forEach(ids, (id) => fetchDoc(id).pipe(Pipe.retry(flakyPolicy)), {
		concurrency: 2,
	});
console.log(show(await Runtime.run(bulk(["a", "b", "a", "b"]))));

// 4. `Safe.allSettled` never fails: every Outcome, in order, for a caller to
// fold. The failing sibling does not abort the rest.
console.log("— allSettled keeps every outcome —");
const partial = Safe.allSettled([fetchDoc("a"), fetchDoc("zzz"), fetchDoc("b")]);
console.log(show(await Runtime.run(partial)));

// 5. Cleanup assembles the same way: `Safe.defer` inside a `Safe.try` pairs
// acquire with release at the body's boundary, and `Pipe.defer` appends a
// per-Safe closing note that runs the moment that Safe settles.
console.log("— cleanup composes in the same list —");
const work = Safe.try(function* () {
	yield* open("conn");
	return yield* fetchDoc("a").pipe(Pipe.retry(flakyPolicy));
}).pipe(Pipe.defer(() => console.log("request ended")));
console.log(show(await Runtime.run(work)));

// 6. A timeout outside `Safe.try` interrupts mid-run; the body's scope still
// releases what was acquired inside.
console.log("— interrupt still releases —");
const slowWork = Safe.try(function* () {
	yield* open("slow-conn");
	return yield* Safe.call(async (s) => {
		await s.sleep(500);
		return "never";
	});
});
console.log(show(await Runtime.run(slowWork.pipe(Pipe.timeout(30)))));
