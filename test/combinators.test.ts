import { describe, expect, test } from "bun:test";
import { Pipe } from "../src/index.ts";
import { Outcome } from "../src/outcome.ts";
import { Policy } from "../src/policy.ts";
import { run, Safe } from "../src/safe.ts";

const slow = (ms: number) =>
	Safe.call(async (s) => {
		await s.sleep(ms);
		return ms;
	});

describe("timeout", () => {
	test("a timeout arrives as interrupt", async () => {
		expect(await run(slow(50).pipe(Pipe.timeout(5)))).toEqual(Outcome.interrupt());
	});

	test("onTimeout turns it into a typed failure", async () => {
		expect(await run(slow(50).pipe(Pipe.timeout(5, () => "too_slow" as const)))).toEqual(
			Outcome.fail("too_slow"),
		);
	});

	test("a fast body is untouched", async () => {
		expect(await run(Safe.ok(1).pipe(Pipe.timeout(50)))).toEqual(Outcome.succeed(1));
	});

	test("a body that fails before the deadline keeps its error", async () => {
		expect(await run(Safe.err("boom").pipe(Pipe.timeout(50, () => "too_slow")))).toEqual(
			Outcome.fail("boom"),
		);
	});
});

describe("Safe.delay", () => {
	test("waits and succeeds with undefined", async () => {
		expect(await run(Safe.delay(1))).toEqual(Outcome.succeed(undefined));
	});

	test("a zero wait takes the sync path", async () => {
		expect(await run(Safe.delay(0))).toEqual(Outcome.succeed(undefined));
	});

	test("an abort during the wait is an interrupt", async () => {
		expect(await run(Safe.delay(50), { signal: AbortSignal.timeout(5) })).toEqual(
			Outcome.interrupt(),
		);
	});
});

describe("Safe.race", () => {
	const slow = () =>
		Safe.call(async (s) => {
			await s.sleep(50);
			return "slow";
		});

	test("keeps the first to settle", async () => {
		expect(await run(Safe.race([slow(), Safe.call(async () => "fast")]))).toEqual(
			Outcome.succeed("fast"),
		);
	});

	test("a synchronous child wins and nothing else starts", async () => {
		let started = false;
		const second = Safe.call(() => {
			started = true;
			return 2;
		});
		expect(await run(Safe.race([Safe.ok(1), second]))).toEqual(Outcome.succeed(1));
		expect(started).toBe(false);
	});

	test("the first failure wins too", async () => {
		const failing = Safe.call(
			async () => {
				throw new Error("boom");
			},
			() => "bad" as const,
		);
		expect(await run(Safe.race([failing, slow()]))).toEqual(Outcome.fail("bad"));
	});

	test("an empty race is a defect naming the rule", async () => {
		const exit = await run(Safe.race([] as Safe<number, never>[]));
		expect(exit._tag).toBe("die");
	});

	test("awaitLosers returns only after the loser settles", async () => {
		const log: string[] = [];
		const loser = Safe.call(async () => {
			await new Promise((r) => setTimeout(r, 30));
			log.push("loser-settled");
			return "loser";
		});
		const winner = Safe.call(() => {
			log.push("winner");
			return "winner";
		});
		const exit = await run(Safe.race([loser, winner], { awaitLosers: true }));
		log.push("returned");
		expect(exit).toEqual(Outcome.succeed("winner"));
		expect(log).toEqual(["winner", "loser-settled", "returned"]);
	});

	test("the default abandons the loser", async () => {
		const log: string[] = [];
		const loser = Safe.call(async (s) => {
			await s.sleep(30);
			log.push("loser-settled");
			return "loser";
		});
		const exit = await run(Safe.race([loser, Safe.ok("winner")]));
		log.push("returned");
		expect(exit).toEqual(Outcome.succeed("winner"));
		expect(log).toEqual(["returned"]);
	});
});

describe("defer (pipe)", () => {
	test("runs cleanup on success and on failure", async () => {
		const seen: string[] = [];
		await run(
			Safe.ok(1).pipe(
				Pipe.defer((exit) => {
					seen.push(exit._tag);
				}),
			),
		);
		await run(
			Safe.err("x" as const).pipe(
				Pipe.defer((exit) => {
					seen.push(exit._tag);
				}),
			),
		);
		expect(seen).toEqual(["success", "fail"]);
	});

	test("a throwing cleanup turns a success into a defect", async () => {
		const defect = new Error("cleanup blew up");
		const exit = await run(
			Safe.ok(1).pipe(
				Pipe.defer(() => {
					throw defect;
				}),
			),
		);
		expect(exit).toEqual(Outcome.die(defect));
	});

	test("a throwing cleanup leaves a failure alone", async () => {
		const exit = await run(
			Safe.err("x" as const).pipe(
				Pipe.defer(() => {
					throw new Error("cleanup blew up");
				}),
			),
		);
		expect(exit).toEqual(Outcome.fail("x"));
	});

	test("an async cleanup is awaited before the outcome is returned", async () => {
		let done = false;
		const exit = await run(
			Safe.ok(1).pipe(
				Pipe.defer(async () => {
					await Promise.resolve();
					done = true;
				}),
			),
		);
		expect(exit).toEqual(Outcome.succeed(1));
		expect(done).toBe(true);
	});
});

describe("retry", () => {
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
		expect(await run(flaky.pipe(Pipe.retry({ attempts: 3 })))).toEqual(Outcome.succeed(3));
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
		expect(await run(always.pipe(Pipe.retry({ attempts: 2 })))).toEqual(
			Outcome.fail("unavailable"),
		);
		expect(attempts).toBe(2);
	});

	test("a policy value drives the same loop", async () => {
		let attempts = 0;
		const always = Safe.call(
			() => {
				attempts++;
				throw new Error("no");
			},
			() => "unavailable" as const,
		);
		expect(
			await run(
				always.pipe(
					Pipe.retry(Policy.pipe(Policy.spaced(1), [Policy.while((s) => s.attempt < 4)])),
				),
			),
		).toEqual(Outcome.fail("unavailable"));
		expect(attempts).toBe(4);
	});

	test("never retries a defect", async () => {
		let attempts = 0;
		const broken = Safe.call(() => {
			attempts++;
			throw new Error("bug");
		});
		const exit = await run(broken.pipe(Pipe.retry({ attempts: 3 })));
		expect(exit._tag).toBe("die");
		expect(attempts).toBe(1);
	});

	test("releases a failed attempt's resources before the next one", async () => {
		let released = 0;
		let attempts = 0;
		const withResource = Safe.try(function* () {
			yield* Safe.defer(Safe.ok("conn"), () => {
				released++;
			});
			attempts++;
			return yield* Safe.err("down" as const);
		});
		expect(await run(withResource.pipe(Pipe.retry({ attempts: 3 })))).toEqual(Outcome.fail("down"));
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
		await run(always.pipe(Pipe.retry({ attempts: 3, delayMs: 10 })));
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

	test("the window slides: a slow item does not hold back the batch behind it", async () => {
		const work = (n: number) => Safe.call((s) => s.sleep(n).then(() => n));
		const started = Date.now();
		const exit = await run(Safe.forEach([10, 200, 10, 200, 10, 200], work, { concurrency: 2 }));
		expect(exit).toEqual(Outcome.succeed([10, 200, 10, 200, 10, 200]));
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(200);
		expect(elapsed).toBeLessThan(550);
	});

	test("a failure stops the remaining items", async () => {
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

describe("Safe.allSettled", () => {
	test("keeps every outcome, in order", async () => {
		const exit = await run(
			Safe.allSettled([Safe.err("a" as const), Safe.ok(1), Safe.err("b" as const)]),
		);
		expect(exit).toEqual(
			Outcome.succeed([Outcome.fail("a"), Outcome.succeed(1), Outcome.fail("b")]),
		);
	});

	test("a failing sibling does not abort the rest", async () => {
		const late = Safe.call(async (s) => {
			await s.sleep(20);
			return "late";
		});
		const exit = await run(Safe.allSettled([Safe.err("no" as const), late]));
		expect(exit).toEqual(Outcome.succeed([Outcome.fail("no"), Outcome.succeed("late")]));
	});
});

describe("Safe.pipe", () => {
	test("folds factories left to right", async () => {
		let attempts = 0;
		const always = Safe.call(
			() => {
				attempts++;
				throw new Error("no");
			},
			() => "unavailable" as const,
		);
		const piped = always.pipe(Pipe.retry({ attempts: 5, delayMs: 30 }), Pipe.timeout(10));
		const exit = await run(piped);
		expect(exit).toEqual(Outcome.interrupt());
		expect(attempts).toBe(1);
	});

	test("the variadic twin is the same fold", async () => {
		const exit = await run(
			Safe.err("boom" as const).pipe(Pipe.timeout(50, () => "too_slow" as const)),
		);
		expect(exit).toEqual(Outcome.fail("boom"));
	});

	test("a user-defined combinator joins the list", async () => {
		const seen: string[] = [];
		const tag =
			(name: string) =>
			(safe: Safe<number, never>): Safe<number, never> =>
				safe.pipe(
					Pipe.defer(() => {
						seen.push(name);
					}),
				);
		const exit = await run(Safe.pipe(Safe.ok(1), tag("first"), tag("second")));
		expect(exit).toEqual(Outcome.succeed(1));

		expect(seen).toEqual(["first", "second"]);
	});
});

describe("scoped", () => {
	test("a Pipe.scoped region closes before the outer scope", async () => {
		const log: string[] = [];
		const s = Safe.try(function* () {
			yield* Safe.defer(Safe.ok(undefined), () => {
				log.push("inner");
			}).pipe(Pipe.scoped);
			log.push("after");
			return 0;
		});
		await run(s);
		expect(log).toEqual(["inner", "after"]);
	});
});
