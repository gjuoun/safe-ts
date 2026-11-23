import { describe, expect, test } from "bun:test";
import { Outcome } from "../src/outcome.ts";
import { run, Safe } from "../src/safe.ts";

const resource = (name: string, log: string[]) =>
	Safe.defer(
		Safe.call(() => name),
		(n: string) => {
			log.push(n);
		},
	);

describe("finalizers run LIFO on fail and interrupt", () => {
	test("on success", async () => {
		const log: string[] = [];
		const s = Safe.try(function* () {
			const a = yield* resource("a", log);
			const b = yield* resource("b", log);
			return a + b;
		});
		expect(await run(s)).toEqual(Outcome.succeed("ab"));
		expect(log).toEqual(["b", "a"]);
	});

	test("on fail", async () => {
		const log: string[] = [];
		const s = Safe.try(function* () {
			yield* resource("a", log);
			yield* resource("b", log);
			return yield* Safe.err("boom");
		});
		expect(await run(s)).toEqual(Outcome.fail("boom"));
		expect(log).toEqual(["b", "a"]);
	});

	test("on interrupt", async () => {
		const log: string[] = [];
		const s = Safe.try(function* () {
			yield* resource("a", log);
			yield* resource("b", log);
			return yield* Safe.call(() => new Promise<never>(() => {}));
		});
		const exit = await run(s, { signal: AbortSignal.timeout(10) });
		expect(exit).toEqual(Outcome.interrupt());
		expect(log).toEqual(["b", "a"]);
	});

	test("on die", async () => {
		const log: string[] = [];
		const defect = new Error("bug");
		const s = Safe.try(function* () {
			yield* resource("a", log);
			return yield* Safe.call((): number => {
				throw defect;
			});
		});
		expect(await run(s)).toEqual(Outcome.die(defect));
		expect(log).toEqual(["a"]);
	});

	test("release receives the outcome", async () => {
		const seen: string[] = [];
		const s = Safe.try(function* () {
			yield* Safe.defer(Safe.ok(1), (_r: number, outcome) => {
				seen.push(outcome._tag);
			});
			return yield* Safe.err("x");
		});
		await run(s);
		expect(seen).toEqual(["fail"]);
	});
});

describe("scoped", () => {
	test("closes the inner scope before the outer continues", async () => {
		const log: string[] = [];
		const s = Safe.try(function* () {
			yield* Safe.try(function* () {
				yield* Safe.defer(Safe.ok("inner"), (n: string) => {
					log.push(n);
				});
				return 0;
			});
			log.push("after-inner");
			yield* Safe.defer(Safe.ok(undefined), () => {
				log.push("outer");
			});
			return 0;
		});
		await run(s);
		expect(log).toEqual(["inner", "after-inner", "outer"]);
	});

	test("a throwing finalizer turns success into die", async () => {
		const defect = new Error("close failed");
		const s = Safe.try(function* () {
			yield* Safe.defer(Safe.ok(undefined), () => {
				throw defect;
			});
			return 1;
		});
		expect(await run(s)).toEqual(Outcome.die(defect));
	});

	test("acquire finishes even if the run is aborted mid-acquire", async () => {
		const log: string[] = [];
		const ac = new AbortController();
		const s = Safe.defer(
			Safe.call(async () => {
				ac.abort();
				await new Promise((r) => setTimeout(r, 5));
				return "conn";
			}),
			(c: string) => {
				log.push(`released ${c}`);
			},
		);
		expect(await run(s, { signal: ac.signal })).toEqual(Outcome.interrupt());
		expect(log).toEqual(["released conn"]);
	});
});
