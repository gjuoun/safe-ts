import { describe, expect, test } from "bun:test";
import { Outcome } from "../src/outcome.ts";
import { makeRuntime } from "../src/runtime.ts";
import { run, Safe } from "../src/safe.ts";
import { get, provide } from "../src/services.ts";

const resource = (name: string, log: string[]) =>
	Safe.acquireRelease(
		Safe.call(() => name),
		(n) => {
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
		console.log("interrupt order:", JSON.stringify(log));
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
			yield* Safe.acquireRelease(Safe.ok(1), (_, outcome) => {
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
			yield* Safe.scoped(resource("inner", log));
			log.push("after-scoped");
			yield* Safe.acquireRelease(Safe.ok(undefined), () => {
				log.push("outer");
			});
			return 0;
		});
		await run(s);
		expect(log).toEqual(["inner", "after-scoped", "outer"]);
	});

	test("a throwing finalizer turns success into die", async () => {
		const defect = new Error("close failed");
		const s = Safe.try(function* () {
			yield* Safe.acquireRelease(Safe.ok(undefined), () => {
				throw defect;
			});
			return 1;
		});
		expect(await run(s)).toEqual(Outcome.die(defect));
	});

	test("acquire finishes even if the run is aborted mid-acquire", async () => {
		const log: string[] = [];
		const ac = new AbortController();
		const acquire = Safe.call(async () => {
			ac.abort();
			await new Promise((r) => setTimeout(r, 5));
			return "conn";
		});
		const s = Safe.acquireRelease(acquire, (c) => {
			log.push(`released ${c}`);
		});
		expect(await run(s, { signal: ac.signal })).toEqual(Outcome.interrupt());
		expect(log).toEqual(["released conn"]);
	});
});

describe("runtime", () => {
	const makeDb = (counters: { builds: number; released: number }) =>
		class Db {
			open = true;
			static *init() {
				counters.builds++;
				return new Db();
			}
			query() {
				return this.open ? "rows" : "closed";
			}
			*dispose() {
				this.open = false;
				counters.released++;
			}
		};

	test("runtime builds once across 3 runs", async () => {
		const counters = { builds: 0, released: 0 };
		const Db = makeDb(counters);
		const rt = makeRuntime([Db]);
		const q = Safe.try(function* () {
			return (yield* get(Db)).query();
		});
		const exits = [await rt.run(q), await rt.run(q), await rt.run(q)];
		console.log("builds:", counters.builds);
		expect(exits).toEqual([
			Outcome.succeed("rows"),
			Outcome.succeed("rows"),
			Outcome.succeed("rows"),
		]);
		expect(counters.builds).toBe(1);
		await rt.dispose();
	});

	test("dispose releases after use", async () => {
		const counters = { builds: 0, released: 0 };
		const Db = makeDb(counters);
		const rt = makeRuntime([Db]);
		const open = Safe.try(function* () {
			return (yield* get(Db)).open;
		});
		expect(await rt.run(open)).toEqual(Outcome.succeed(true));
		console.log("released before dispose:", counters.released);
		expect(counters.released).toBe(0);
		await rt.dispose();
		console.log("released after dispose:", counters.released);
		expect(counters.released).toBe(1);
		await rt.dispose();
		expect(counters.released).toBe(1);
	});

	test("run after dispose is a die", async () => {
		const rt = makeRuntime([makeDb({ builds: 0, released: 0 })]);
		await rt.dispose();
		const exit = await rt.run(Safe.ok(1));
		expect(exit._tag).toBe("die");
	});

	test("a per-run abort does not tear down runtime services", async () => {
		const counters = { builds: 0, released: 0 };
		const Db = makeDb(counters);
		const rt = makeRuntime([Db]);
		const slow = Safe.try(function* () {
			yield* get(Db);
			return yield* Safe.call(() => new Promise<never>(() => {}));
		});
		expect(await rt.run(slow, { signal: AbortSignal.timeout(5) })).toEqual(Outcome.interrupt());
		const q = Safe.try(function* () {
			return (yield* get(Db)).query();
		});
		expect(await rt.run(q)).toEqual(Outcome.succeed("rows"));
		expect(counters).toEqual({ builds: 1, released: 0 });
		await rt.dispose();
	});

	test("a failed build is retried on the next run", async () => {
		let attempts = 0;
		class Flaky {
			static *init() {
				attempts++;
				if (attempts === 1) return yield* Safe.err("down" as const);
				return new Flaky();
			}
		}
		const rt = makeRuntime([Flaky]);
		const use = Safe.try(function* () {
			yield* get(Flaky);
			return attempts;
		});
		expect(await rt.run(use)).toEqual(Outcome.fail("down"));
		expect(await rt.run(use)).toEqual(Outcome.succeed(2));
		await rt.dispose();
	});

	test("a class provided inside run is disposed when the run ends", async () => {
		const counters = { builds: 0, released: 0 };
		const Db = makeDb(counters);
		const program = provide(
			Safe.try(function* () {
				return (yield* get(Db)).query();
			}),
			[Db],
		);
		expect(await run(program)).toEqual(Outcome.succeed("rows"));
		expect(counters).toEqual({ builds: 1, released: 1 });
	});
});
