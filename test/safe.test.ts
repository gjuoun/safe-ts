import { describe, expect, test } from "bun:test";
import { defineErrors } from "../src/errors.ts";
import { Pipe } from "../src/index.ts";
import { Outcome } from "../src/outcome.ts";
import { run, Safe } from "../src/safe.ts";

const userError = defineErrors({
	not_found: (id: string) => ({ message: `no user ${id}`, id }),
});

describe("Safe constructors", () => {
	test("succeed and fail", async () => {
		expect(await run(Safe.ok(1))).toEqual(Outcome.succeed(1));
		expect(await run(Safe.err("x"))).toEqual(Outcome.fail("x"));
	});

	test("is lazy", async () => {
		let calls = 0;
		const s = Safe.call(() => ++calls);
		expect(calls).toBe(0);
		expect(await run(s)).toEqual(Outcome.succeed(1));
		expect(calls).toBe(1);
		expect(await run(s)).toEqual(Outcome.succeed(2));
	});

	test("try maps a throw to fail", async () => {
		const s = Safe.call(
			() => JSON.parse("{"),
			() => "bad_json" as const,
		);
		expect(await run(s)).toEqual(Outcome.fail("bad_json"));
	});
	test("try without a mapper keeps a throw as a defect", async () => {
		const defect = new Error("boom");
		const s = Safe.call((): number => {
			throw defect;
		});
		expect(await run(s)).toEqual(Outcome.die(defect));
	});

	test("call refuses a generator function and names Safe.try", async () => {
		const exit = await run(
			// A generator function belongs to Safe.try, not Safe.call.
			Safe.call(function* () {
				yield* Safe.ok(1);
				return 2;
			}),
		);
		expect(exit._tag).toBe("die");
		if (exit._tag === "die") {
			expect(String(exit.defect)).toContain("use Safe.try");
		}
	});

	test("promise maps a rejection to fail only when a mapper is given", async () => {
		const boom = new Error("boom");
		expect(await run(Safe.call(() => Promise.reject(boom)))).toEqual(Outcome.die(boom));
		expect(
			await run(
				Safe.call(
					() => Promise.reject(boom),
					(e) => (e as Error).message,
				),
			),
		).toEqual(Outcome.fail("boom"));
	});
});

describe("a thrown defect is die, not fail", () => {
	const defect = new Error("bug");
	const thrower = (): number => {
		throw defect;
	};

	test("in sync", async () => {
		expect(await run(Safe.call(thrower))).toEqual(Outcome.die(defect));
	});

	test("in a gen body", async () => {
		const s = Safe.try(function* () {
			yield* Safe.ok(1);
			return thrower();
		});
		const exit = await run(s);
		expect(exit).toEqual(Outcome.die(defect));
		expect(Outcome.isDie(exit)).toBe(true);
	});
});

describe("Safe.try", () => {
	test("composes Safe yields", async () => {
		const s = Safe.try(function* () {
			const a = yield* Safe.ok(2);
			const b = yield* Safe.ok(3);
			const c = yield* Safe.call(async () => 4);
			return a * b * c;
		});
		expect(await run(s)).toEqual(Outcome.succeed(24));
	});

	test("short-circuits on fail and runs finally", async () => {
		const seen: string[] = [];
		const s = Safe.try(function* () {
			try {
				seen.push("start");
				yield* Safe.err(userError.not_found("u2"));
				seen.push("unreachable");
				return 1;
			} finally {
				seen.push("finally");
			}
		});
		expect(await run(s)).toEqual(Outcome.fail(userError.not_found("u2")));
		expect(seen).toEqual(["start", "finally"]);
	});

	test("re-runs the body on every run", async () => {
		let bodies = 0;
		const s = Safe.try(function* () {
			bodies++;
			return yield* Safe.ok(bodies);
		});
		await run(s);
		expect(await run(s)).toEqual(Outcome.succeed(2));
	});
});

describe("Safe combinators", () => {
	test("Safe.try sequences and short-circuits", async () => {
		const half = (n: number) => (n % 2 === 0 ? Safe.ok(n / 2) : Safe.err("odd"));
		const twice = (n: number) =>
			Safe.try(function* () {
				return yield* half(yield* half(n));
			});
		expect(await run(twice(8))).toEqual(Outcome.succeed(2));
		expect(await run(twice(3))).toEqual(Outcome.fail("odd"));
	});

	test("catchTag recovers one code and keeps the rest", async () => {
		const find = (id: string): Safe<string, ReturnType<typeof userError.not_found>, never> =>
			id === "u1" ? Safe.ok("ada") : Safe.err(userError.not_found(id));
		const recovered = Safe.pipe(find("u2"), [
			Pipe.catchTag("not_found", (e: { id: string }) => Safe.ok(`guest:${e.id}`)),
		]);
		expect(await run(recovered)).toEqual(Outcome.succeed("guest:u2"));
	});

	test("catchTag leaves die alone", async () => {
		const defect = new Error("bug");
		const s = Safe.pipe(
			Safe.call((): string => {
				throw defect;
			}),
			[Pipe.catchTag("not_found", () => Safe.ok("x"))],
		);
		expect(await run(s)).toEqual(Outcome.die(defect));
	});
});
