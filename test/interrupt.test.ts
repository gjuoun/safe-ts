import { describe, expect, test } from "bun:test";
import { all } from "../src/all.ts";
import { Outcome } from "../src/outcome.ts";
import { run, Safe } from "../src/safe.ts";

const sleep = (ms: number) => Safe.call((s) => s.sleep(ms).then(() => ms));

describe("interruption", () => {
	test("abort mid-await yields interrupt", async () => {
		const started = performance.now();
		const exit = await run(sleep(1000), { signal: AbortSignal.timeout(20) });
		const elapsed = performance.now() - started;
		console.log(`interrupt after ${elapsed.toFixed(0)}ms:`, JSON.stringify(exit));
		expect(exit).toEqual(Outcome.interrupt());
		expect(elapsed).toBeLessThan(50);
	});

	test("a promise that ignores the signal is still interrupted", async () => {
		const deaf = Safe.call(() => new Promise<number>((r) => setTimeout(() => r(1), 1000)));
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 10);
		expect(await run(deaf, { signal: ac.signal })).toEqual(Outcome.interrupt());
	});

	test("an already-aborted signal runs nothing", async () => {
		let ran = false;
		const s = Safe.call(() => {
			ran = true;
		});
		expect(await run(s, { signal: AbortSignal.abort() })).toEqual(Outcome.interrupt());
		expect(ran).toBe(false);
	});

	test("gen stops between steps and runs finally", async () => {
		const ac = new AbortController();
		const seen: string[] = [];
		const s = Safe.try(function* () {
			try {
				seen.push("a");
				yield* Safe.call(() => ac.abort());
				seen.push("b");
				yield* Safe.ok(1);
				seen.push("c");
				return 1;
			} finally {
				seen.push("finally");
			}
		});
		expect(await run(s, { signal: ac.signal })).toEqual(Outcome.interrupt());
		// The driver checks the signal before resuming the body, so "b" never runs.
		expect(seen).toEqual(["a", "finally"]);
	});

	test("a mapper does not turn an abort into a fail", async () => {
		const s = Safe.call(
			(s) => fetch("http://127.0.0.1:9/", { signal: s.signal }),
			() => "io" as const,
		);
		expect(await run(s, { signal: AbortSignal.abort() })).toEqual(Outcome.interrupt());
	});
});

describe("Safe.all", () => {
	test("runs concurrently and keeps order", async () => {
		const started = performance.now();
		const exit = await run(all([sleep(30), sleep(10), Safe.ok(0)] as const));
		expect(exit).toEqual(Outcome.succeed([30, 10, 0]));
		expect(performance.now() - started).toBeLessThan(80);
	});

	test("Safe.all aborts siblings on first failure", async () => {
		let siblingAborted = false;
		const sibling = Safe.call(
			(s) =>
				new Promise<number>((resolve) => {
					const t = setTimeout(() => resolve(1), 1000);
					s.onCancel(() => {
						siblingAborted = s.signal.aborted;
						clearTimeout(t);
						resolve(0);
					});
				}),
		);
		const failing = Safe.try(function* () {
			yield* sleep(10);
			return yield* Safe.err("boom" as const);
		});
		const started = performance.now();
		const exit = await run(all([sibling, failing] as const));
		console.log("sibling aborted:", siblingAborted);
		expect(exit).toEqual(Outcome.fail("boom"));
		expect(siblingAborted).toBe(true);
		expect(performance.now() - started).toBeLessThan(200);
	});

	test("a die wins like a fail", async () => {
		const defect = new Error("bug");
		const exit = await run(
			all([
				sleep(500),
				Safe.call((): number => {
					throw defect;
				}),
			]),
		);
		expect(exit).toEqual(Outcome.die(defect));
	});

	test("an outer abort interrupts all", async () => {
		expect(await run(all([sleep(1000), sleep(1000)]), { signal: AbortSignal.timeout(10) })).toEqual(
			Outcome.interrupt(),
		);
	});
});

describe("uninterruptible / interruptible", () => {
	test("a masked region survives a timeout and reports interrupt at exit", async () => {
		const { Pipe } = await import("../src/index.ts");
		let ran = 0;
		const region = Safe.call(async (s) => {
			await s.sleep(30);
			ran = 1;
			return "done";
		});
		const exit = await run(region.pipe(Pipe.uninterruptible).pipe(Pipe.timeout(10)));
		expect(ran).toBe(1);
		expect(exit).toEqual(Outcome.interrupt());
	});

	test("an unmasked region under the same timeout is cut", async () => {
		const { Pipe } = await import("../src/index.ts");
		let ran = 0;
		const region = Safe.call(async (s) => {
			await s.sleep(30);
			ran = 1;
			return "done";
		});
		const exit = await run(region.pipe(Pipe.timeout(10)));
		expect(ran).toBe(0);
		expect(exit).toEqual(Outcome.interrupt());
	});

	test("defer still runs after a masked region reports interrupt", async () => {
		const { Pipe } = await import("../src/index.ts");
		const seen: string[] = [];
		const region = Safe.call(async (s) => {
			await s.sleep(30);
			return "done";
		});
		const exit = await run(
			region.pipe(
				Pipe.uninterruptible,
				Pipe.defer((e) => {
					seen.push(e._tag);
				}),
				Pipe.timeout(10),
			),
		);
		expect(exit).toEqual(Outcome.interrupt());
		expect(seen).toEqual(["interrupt"]);
	});

	test("Pipe.interruptible inside Pipe.uninterruptible opts the region back in", async () => {
		const { Pipe } = await import("../src/index.ts");
		let inner = 0;
		let outer = 0;
		const region = Safe.try(function* () {
			yield* Safe.call(async (s) => {
				await s.sleep(30);
				outer = 1;
			});
			// The inner region sees the real signal again.
			yield* Safe.call(async (s) => {
				await s.sleep(30);
				inner = 1;
			}).pipe(Pipe.interruptible);
			return "done";
		});
		const exit = await run(region.pipe(Pipe.uninterruptible).pipe(Pipe.timeout(100)));
		// Both waits finished: outer was masked, inner re-exposed and the run
		// itself was never aborted — 100 > 30 + 30 + margin.
		expect(outer).toBe(1);
		expect(inner).toBe(1);
		expect(exit).toEqual(Outcome.succeed("done"));
	});

	test("Pipe.interruptible inside Pipe.uninterruptible is cut by the deadline", async () => {
		const { Pipe } = await import("../src/index.ts");
		let inner = 0;
		const region = Safe.try(function* () {
			return yield* Safe.call(async (s) => {
				await s.sleep(30);
				inner = 1;
				return "done";
			}).pipe(Pipe.interruptible);
		});
		const exit = await run(region.pipe(Pipe.uninterruptible).pipe(Pipe.timeout(10)));
		// The inner wait was Pipe.interruptible again: the deadline cut it, the mask
		// still reported the interrupt when the region exited.
		expect(inner).toBe(0);
		expect(exit).toEqual(Outcome.interrupt());
	});
});
