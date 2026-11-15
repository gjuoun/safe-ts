// examples/05-concurrency-and-cleanup.ts — `Safe.all`, interruption, finalizers.
//
// `Safe.all` runs Safes concurrently and keeps result order; the first fail or
// die aborts the rest. There is no `timeout` operator — `AbortSignal.timeout`
// passed to `run` bounds any wait, because `Scheduler.sleep` waits on the run's
// signal and stops on abort even if nothing else in the callback cooperates.
// `Safe.acquireRelease` and `Safe.scoped` register cleanup that runs last-in,
// first-out on every exit: success, fail, die and interrupt.
//
//   bun run examples/05-concurrency-and-cleanup.ts
import { type Outcome, run, Safe } from "../src/index.ts";

// The scheduler waits on the run's signal; a rejection caused by an abort is an
// interrupt, not a typed fail.
const fetchDoc = (id: string, ms: number) =>
	Safe.call(
		async (s) => {
			console.log(`start ${id}`);
			await s.sleep(ms);
			return `doc:${id}`;
		},
		(): `fetch_failed:${string}` => `fetch_failed:${id}`,
	);

// A resource that always reports when it is released — and why.
const open = (name: string) =>
	Safe.acquireRelease(
		Safe.call(() => {
			console.log(`open ${name}`);
			return name;
		}),
		(_resource, exit) => console.log(`close ${name} (${exit._tag})`),
	);

const show = <A, E>(exit: Outcome<A, E>): string => {
	if (exit._tag === "success") return `ok: ${JSON.stringify(exit.value)}`;
	return exit._tag === "fail" ? `fail: ${JSON.stringify(exit.error)}` : exit._tag;
};

// 1. Concurrent success: results keep input order.
console.log(show(await run(Safe.all([fetchDoc("a", 5), fetchDoc("b", 10)]))));

// 2. Fail-fast: the first failure aborts the in-flight siblings.
console.log(show(await run(Safe.all([fetchDoc("c", 500), fetchDoc("d", 500), Safe.err("boom")]))));

// 3. `AbortSignal.timeout` bounds a run — no timeout operator needed.
console.log(show(await run(fetchDoc("slow", 500), { signal: AbortSignal.timeout(20) })));

// 4. `scoped` + a release with no resource: cleanup runs LIFO, on fail as on success.
const work = Safe.scoped(
	Safe.try(function* () {
		yield* open("db");
		yield* Safe.acquireRelease(Safe.ok(undefined), () => console.log("checkpoint"));
		return yield* Safe.err("crash");
	}),
);
console.log(show(await run(work)));

// 5. Interrupting mid-run still releases what was acquired.
const slowWork = Safe.scoped(
	Safe.try(function* () {
		yield* open("conn");
		return yield* fetchDoc("slow", 500);
	}),
);
console.log(show(await run(slowWork, { signal: AbortSignal.timeout(20) })));
