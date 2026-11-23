import { describe, expect, test } from "bun:test";
import { Outcome } from "../src/outcome.ts";
import { run, Safe } from "../src/safe.ts";

const parse = (s: string): Safe<number, string> => {
	const n = Number(s);
	return Number.isNaN(n) ? Safe.err(`nan: ${s}`) : Safe.ok(n);
};

const raise = (e: unknown): never => {
	throw e;
};

describe("Safe.try (sync body)", () => {
	test("is lazy", async () => {
		let bodies = 0;
		const s = Safe.try(function* () {
			bodies++;
			return yield* parse("1");
		});
		expect(bodies).toBe(0);
		expect(await run(s)).toEqual(Outcome.succeed(1));
		expect(bodies).toBe(1);
		await run(s);
		expect(bodies).toBe(2);
	});

	test("unwraps yielded Safes", async () => {
		const s = Safe.try(function* () {
			const a = yield* parse("2");
			const b = yield* parse("3");
			return a + b;
		});
		expect(await run(s)).toEqual(Outcome.succeed(5));
	});

	test("short-circuits on the first failure", async () => {
		const seen: string[] = [];
		const s = Safe.try(function* () {
			seen.push("a");
			yield* parse("x");
			seen.push("b");
			return 0;
		});
		expect(await run(s)).toEqual(Outcome.fail("nan: x"));
		expect(seen).toEqual(["a"]);
	});

	test("an early failure is a fail", async () => {
		const s = Safe.try(function* () {
			const n = yield* parse("-1");
			if (n < 0) return yield* Safe.err("negative");
			return n;
		});
		expect(await run(s)).toEqual(Outcome.fail("negative"));
	});

	test("a plain return value is the success value", async () => {
		const s = Safe.try(function* () {
			return (yield* parse("4")) * 2;
		});
		expect(await run(s)).toEqual(Outcome.succeed(8));
	});

	test("runs finally when a yielded failure short-circuits", async () => {
		let finallyRuns = 0;
		const s = Safe.try(function* () {
			try {
				yield* parse("x");
				return 1;
			} finally {
				finallyRuns++;
			}
		});
		expect(await run(s)).toEqual(Outcome.fail("nan: x"));
		expect(finallyRuns).toBe(1);
	});

	test("composes Safe yields", async () => {
		const s = Safe.try(function* () {
			const a = yield* Safe.ok(2);
			const b = yield* Safe.call(async () => 3);
			return a * b;
		});
		expect(await run(s)).toEqual(Outcome.succeed(6));
	});
});

describe("Safe.try (async body)", () => {
	const fetchNum = async (s: string) => parse(s);

	test("yields awaited Safes", async () => {
		const s = Safe.try(async function* () {
			const a = yield* await fetchNum("4");
			const b = yield* parse("1");
			return a - b;
		});
		expect(await run(s)).toEqual(Outcome.succeed(3));
	});

	test("runs finally when a yielded failure short-circuits", async () => {
		let finallyRuns = 0;
		const s = Safe.try(async function* () {
			try {
				yield* await fetchNum("y");
				return 1;
			} finally {
				finallyRuns++;
			}
		});
		expect(await run(s)).toEqual(Outcome.fail("nan: y"));
		expect(finallyRuns).toBe(1);
	});

	test("async finally can await", async () => {
		const seen: string[] = [];
		const s = Safe.try(async function* () {
			try {
				yield* parse("x");
				return 1;
			} finally {
				await new Promise((r) => setTimeout(r, 5));
				seen.push("cleaned");
			}
		});
		expect(await run(s)).toEqual(Outcome.fail("nan: x"));
		expect(seen).toEqual(["cleaned"]);
	});

	test("yields Safe values from an async body", async () => {
		const s = Safe.try(async function* () {
			const a = yield* Safe.ok(2);
			const b = yield* Safe.call(async () => 5);
			return a + b;
		});
		expect(await run(s)).toEqual(Outcome.succeed(7));
	});

	test("a throw in the body is a die", async () => {
		const defect = new Error("bug");
		const s = Safe.try(async function* () {
			yield* parse("1");
			throw defect;
		});
		expect(await run(s)).toEqual(Outcome.die(defect));
	});

	test("a throwing finally keeps the error the body already failed with", async () => {
		const s = Safe.try(function* () {
			try {
				return yield* Safe.err("stopped");
			} finally {
				raise(new Error("cleanup blew up"));
			}
		});
		expect(await run(s)).toEqual(Outcome.fail("stopped"));
	});

	test("yield* Safe.ok completes inline with its value", async () => {
		let seen = 0;
		const s = Safe.try(function* () {
			const a = yield* Safe.ok(1);
			seen = a;
			const b = yield* Safe.ok(2);
			return a + b;
		});
		expect(await run(s)).toEqual(Outcome.succeed(3));
		expect(seen).toBe(1);
	});

	test("a plain yield body runs the same as yield*", async () => {
		const s = Safe.try(function* () {
			const a = (yield parse("1")) as number;
			const b = (yield parse("2")) as number;
			return a + b;
		});
		expect(await run(s)).toEqual(Outcome.succeed(3));
	});

	test("a plain yield body stops on the first failure", async () => {
		let after = 0;
		const s = Safe.try(function* () {
			const a = (yield parse("1")) as number;
			yield parse("nope");
			after++;
			return a;
		});
		expect(await run(s)).toEqual(Outcome.fail("nan: nope"));
		expect(after).toBe(0);
	});

	test("a throwing finally on success is a die", async () => {
		const defect = new Error("cleanup blew up");
		const s = Safe.try(function* () {
			try {
				return yield* Safe.ok(1);
			} finally {
				raise(defect);
			}
		});
		expect(await run(s)).toEqual(Outcome.die(defect));
	});
});
