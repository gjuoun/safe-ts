import { describe, expect, test } from "bun:test";
import { Outcome } from "../src/outcome.ts";
import { run, Safe } from "../src/safe.ts";

const slow = (ms: number) =>
	Safe.call(async (s) => {
		await s.sleep(ms);
		return ms;
	});

describe("Safe.timeout", () => {
	test("a timeout arrives as interrupt", async () => {
		expect(await run(Safe.timeout(slow(50), 5))).toEqual(Outcome.interrupt());
	});

	test("onTimeout turns it into a typed failure", async () => {
		expect(await run(Safe.timeout(slow(50), 5, () => "too_slow" as const))).toEqual(
			Outcome.fail("too_slow"),
		);
	});

	test("a fast body is untouched", async () => {
		expect(await run(Safe.timeout(Safe.ok(1), 50))).toEqual(Outcome.succeed(1));
	});

	test("a body that fails before the deadline keeps its error", async () => {
		expect(await run(Safe.timeout(Safe.err("boom"), 50, () => "too_slow"))).toEqual(
			Outcome.fail("boom"),
		);
	});
});

describe("Safe.retry", () => {
	test("retries a typed failure until it succeeds", async () => {
		let attempts = 0;
		const flaky = Safe.call(
			() => {
				attempts++;
				if (attempts < 3) throw new Error("not yet");
				return attempts;
			},
			() => "unavailable" as const,
		);
		expect(await run(Safe.retry(flaky, { attempts: 3 }))).toEqual(Outcome.succeed(3));
		expect(attempts).toBe(3);
	});

	test("stops after the last attempt and keeps the error", async () => {
		let attempts = 0;
		const always = Safe.call(
			() => {
				attempts++;
				throw new Error("no");
			},
			() => "unavailable" as const,
		);
		expect(await run(Safe.retry(always, { attempts: 2 }))).toEqual(Outcome.fail("unavailable"));
		expect(attempts).toBe(2);
	});

	test("never retries a defect", async () => {
		let attempts = 0;
		const broken = Safe.call(() => {
			attempts++;
			throw new Error("bug");
		});
		const exit = await run(Safe.retry(broken, { attempts: 3 }));
		expect(exit._tag).toBe("die");
		expect(attempts).toBe(1);
	});

	test("releases a failed attempt's resources before the next one", async () => {
		let released = 0;
		let attempts = 0;
		const withResource = Safe.try(function* () {
			yield* Safe.acquireRelease(Safe.ok("conn"), () => {
				released++;
			});
			attempts++;
			return yield* Safe.err("down" as const);
		});
		expect(await run(Safe.retry(withResource, { attempts: 3 }))).toEqual(Outcome.fail("down"));
		expect(attempts).toBe(3);
		expect(released).toBe(3);
	});

	test("pauses between attempts when asked", async () => {
		let attempts = 0;
		const always = Safe.call(
			() => {
				attempts++;
				throw new Error("no");
			},
			() => "unavailable" as const,
		);
		const started = Date.now();
		await run(Safe.retry(always, { attempts: 3, delayMs: 10 }));
		expect(attempts).toBe(3);
		expect(Date.now() - started).toBeGreaterThanOrEqual(20);
	});
});

describe("Safe.forEach", () => {
	test("keeps input order", async () => {
		const exit = await run(Safe.forEach([1, 2, 3, 4, 5], (n, i) => Safe.ok(`${i}:${n * 2}`)));
		expect(exit).toEqual(Outcome.succeed(["0:2", "1:4", "2:6", "3:8", "4:10"]));
	});

	test("honours the concurrency limit", async () => {
		let live = 0;
		let peak = 0;
		const work = (n: number) =>
			Safe.call(async () => {
				live++;
				peak = Math.max(peak, live);
				await new Promise((r) => setTimeout(r, 2));
				live--;
				return n;
			});
		const exit = await run(Safe.forEach([1, 2, 3, 4, 5, 6], work, { concurrency: 2 }));
		expect(exit).toEqual(Outcome.succeed([1, 2, 3, 4, 5, 6]));
		expect(peak).toBeLessThanOrEqual(2);
	});

	test("a failure stops the remaining batches", async () => {
		// One at a time: without a limit every child starts at once (Safe.all), so
		// only a batch boundary can keep later work from running at all.
		const seen: number[] = [];
		const exit = await run(
			Safe.forEach(
				[1, 2, 3, 4],
				(n) => {
					seen.push(n);
					return n === 2 ? Safe.err("stop" as const) : Safe.ok(n);
				},
				{ concurrency: 1 },
			),
		);
		expect(exit).toEqual(Outcome.fail("stop"));
		expect(seen).toEqual([1, 2]);
	});
});
