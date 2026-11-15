import { describe, expect, test } from "bun:test";
import { Outcome } from "../src/outcome.ts";
import { makeRuntime } from "../src/runtime.ts";
import { run, Safe } from "../src/safe.ts";
import { get, override, provide } from "../src/services.ts";

const makeClasses = () => {
	const log: string[] = [];
	const counts = { config: 0, db: 0 };

	class Config {
		constructor(readonly url: string) {}
		static *init() {
			counts.config++;
			return new Config("mem://a");
		}
	}

	class Db {
		constructor(readonly url: string) {}
		static async *init() {
			counts.db++;
			const config = yield* get(Config);
			await new Promise((r) => setTimeout(r, 1));
			return new Db(`db+${config.url}`);
		}
		query(q: string) {
			return `${this.url}?${q}`;
		}
		async *dispose() {
			await new Promise((r) => setTimeout(r, 1));
			log.push("Db");
		}
	}

	class Cache {
		constructor(readonly url: string) {}
		static *init() {
			return new Cache(`cache+${(yield* get(Config)).url}`);
		}
	}

	class UserRepo {
		constructor(
			readonly db: Db,
			readonly cache: Cache,
		) {}
		static *init() {
			const db = yield* get(Db);
			const cache = yield* get(Cache);
			return new UserRepo(db, cache);
		}
		*dispose() {
			log.push("UserRepo");
		}
	}

	return { Config, Db, Cache, UserRepo, log, counts };
};

describe("class services", () => {
	test("init gets its deps", async () => {
		const { Config, Db } = makeClasses();
		const program = Safe.try(function* () {
			return (yield* get(Db)).query("x");
		});
		expect(await run(provide(program, [Db, Config]))).toEqual(Outcome.succeed("db+mem://a?x"));
	});

	test("builds a shared class once", async () => {
		const { Config, Db, Cache, UserRepo, counts } = makeClasses();
		const program = Safe.try(async function* () {
			const repo = yield* get(UserRepo);
			const config = yield* get(Config);
			const db = yield* get(Db);
			return [repo.cache.url, config.url, db.url];
		});
		const exit = await run(provide(program, [UserRepo, Db, Cache, Config]));
		console.log("builds:", counts.config);
		expect(exit).toEqual(Outcome.succeed(["cache+mem://a", "mem://a", "db+mem://a"]));
		expect(counts).toEqual({ config: 1, db: 1 });
	});

	test("each run builds afresh", async () => {
		const { Config, counts } = makeClasses();
		const program = provide(
			Safe.try(function* () {
				return (yield* get(Config)).url;
			}),
			[Config],
		);
		await run(program);
		await run(program);
		expect(counts.config).toBe(2);
	});

	test("a failing init is a fail", async () => {
		const seen: string[] = [];
		class Yielded {
			static *init() {
				yield* Safe.err({ code: "bad" as const });
				return new Yielded();
			}
		}
		class Fine {
			static *init() {
				return new Fine();
			}
		}
		const program = Safe.try(function* () {
			seen.push("before");
			yield* get(Fine);
			yield* get(Yielded);
			seen.push("after");
			return 1;
		});
		expect(await run(provide(program, [Yielded, Fine]))).toEqual(Outcome.fail({ code: "bad" }));
		expect(seen).toEqual(["before"]);
	});

	test("a throwing init is a die", async () => {
		const defect = new Error("bad config");
		class Plain {
			static *init(): Generator<never, Plain, unknown> {
				throw defect;
			}
		}
		class Gen {
			static *init(): Generator<Safe<number, never, never>, Gen, unknown> {
				yield* Safe.ok(1);
				throw defect;
			}
		}
		const use = (c: typeof Plain | typeof Gen) =>
			Safe.try(function* () {
				return yield* get(c);
			});
		expect(await run(provide(use(Plain), [Plain, Gen]))).toEqual(Outcome.die(defect));
		expect(await run(provide(use(Gen), [Plain, Gen]))).toEqual(Outcome.die(defect));
	});

	test("disposes last-built first when the run ends", async () => {
		const { Config, Db, Cache, UserRepo, log } = makeClasses();
		const program = Safe.try(function* () {
			yield* get(UserRepo);
			log.push("body");
			return 0;
		});
		await run(provide(program, [UserRepo, Db, Cache, Config]));
		console.log("dispose order:", JSON.stringify(log));
		expect(log).toEqual(["body", "UserRepo", "Db"]);
	});

	test("init receives the params", async () => {
		class Configured {
			constructor(readonly url: string) {}
			static *init(params: { url: string }) {
				return new Configured(params.url);
			}
		}
		const program = Safe.try(function* () {
			return (yield* get(Configured)).url;
		});
		expect(await run(provide(program, [Configured], { url: "mem://params" }))).toEqual(
			Outcome.succeed("mem://params"),
		);
	});

	test("a runtime passes params to every init", async () => {
		class Configured {
			constructor(readonly url: string) {}
			static *init(params: { url: string }) {
				return new Configured(params.url);
			}
		}
		const runtime = makeRuntime([Configured], { url: "mem://runtime" });
		const program = Safe.try(function* () {
			return (yield* get(Configured)).url;
		});
		expect(await runtime.run(program)).toEqual(Outcome.succeed("mem://runtime"));
		await runtime.dispose();
	});

	test("a generator dispose can get a dependency", async () => {
		const log: string[] = [];
		class Logger {
			static *init() {
				return new Logger();
			}
			info(msg: string) {
				log.push(msg);
			}
		}
		class Worker {
			static *init() {
				return new Worker();
			}
			*dispose() {
				log.push(`closed by ${(yield* get(Logger)).constructor.name}`);
			}
		}
		const program = Safe.try(function* () {
			yield* get(Worker);
			return 0;
		});
		await run(provide(program, [Worker, Logger]));
		expect(log).toEqual(["closed by Logger"]);
	});

	test("a plain dispose is a defect naming the rule", async () => {
		class Legacy {
			static *init() {
				return new Legacy();
			}
			dispose() {
				// Not a generator: the driver never calls this.
			}
		}
		const program = Safe.try(function* () {
			yield* get(Legacy);
			return 0;
		});
		const exit = await run(provide(program, [Legacy]));
		expect(exit._tag).toBe("die");
		expect(String(exit._tag === "die" ? exit.defect : "")).toContain("*dispose()");
	});

	test("a failing generator dispose is a defect", async () => {
		class Fragile {
			static *init() {
				return new Fragile();
			}
			*dispose() {
				yield* Safe.err("close_failed" as const);
			}
		}
		const program = Safe.try(function* () {
			yield* get(Fragile);
			return 0;
		});
		expect(await run(provide(program, [Fragile]))).toEqual(Outcome.die("close_failed"));
	});

	test("an async generator dispose is awaited", async () => {
		const { Config, Db, log } = makeClasses();
		const program = provide(
			Safe.try(function* () {
				return (yield* get(Db)).url;
			}),
			[Db, Config],
		);
		await run(program);
		expect(log).toEqual(["Db"]);
	});

	test("override replaces a class", async () => {
		const { Db, UserRepo, Cache, Config } = makeClasses();
		class FakeDb extends Db {
			override query(q: string) {
				return `fake?${q}`;
			}
		}
		const program = Safe.try(function* () {
			const repo = yield* get(UserRepo);
			return repo.db.query("y");
		});
		const exit = await run(
			provide(program, [UserRepo, Cache, Config, override(Db, new FakeDb("unused"))]),
		);
		expect(exit).toEqual(Outcome.succeed("fake?y"));
	});

	test("nested provide resolves deps from the outer list", async () => {
		const { Config, Db } = makeClasses();
		const inner = provide(
			Safe.try(function* () {
				return (yield* get(Db)).url;
			}),
			[Db],
		);
		expect(await run(provide(inner, [Config]))).toEqual(Outcome.succeed("db+mem://a"));
	});

	test("init can yield a Safe", async () => {
		class Slow {
			constructor(readonly n: number) {}
			static *init() {
				return new Slow(yield* Safe.call(async () => 42));
			}
		}
		const program = Safe.try(function* () {
			return (yield* get(Slow)).n;
		});
		expect(await run(provide(program, [Slow]))).toEqual(Outcome.succeed(42));
	});

	test("a dependency cycle is a die naming the chain", async () => {
		class A {
			static *init(): Generator<unknown, A, any> {
				yield* get(B as never);
				return new A();
			}
		}
		class B {
			static *init(): Generator<unknown, B, any> {
				yield* get(A as never);
				return new B();
			}
		}
		const program = Safe.try(function* () {
			return yield* get(A);
		});
		const exit = await run(provide(program, [A, B] as never) as never);
		expect(exit._tag).toBe("die");
		if (exit._tag === "die") {
			expect(String(exit.defect)).toContain("A -> B -> A");
		}
	});

	test("a missing class (cast) is a die naming it", async () => {
		const { Config } = makeClasses();
		const program = Safe.try(function* () {
			return yield* get(Config);
		});
		const exit = await run(program as never);
		expect(exit._tag).toBe("die");
		if (exit._tag === "die") {
			expect(String(exit.defect)).toContain('"Config" was not provided');
		}
	});
});
