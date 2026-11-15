// examples/04-services.ts — class services: `get`, `provide`, `instance`.
//
// A service is a plain class with `static init`. The constructor takes what
// the class needs; `init` obtains it — a generator `init` names deps with
// `yield* Services.get(Dep)` and may fail with `yield* Safe.err(...)`. `init` may be
// async: `async *init` awaits real setup and still gets its deps.
// A service never reads the environment. The composition root reads it once
// and hands the value in as a ready instance with `instance`. `provide`
// supplies the classes a Safe's `R` asks for; `run` refuses a Safe whose `R` is
// not `never`, so a missing service is a compile error. An instance that
// declares `*dispose()` is cleaned up last-built first — a generator like
// `init`, so cleanup can `yield*` a `Services.get(Dep)`.
//
//   bun run examples/04-services.ts
import { Errors, type Outcome, Runtime, Safe, Services } from "../src/index.ts";

class Logger {
	static *init() {
		return new Logger();
	}
	info(msg: string) {
		console.log(`info: ${msg}`);
	}
}

// A value-only service: it names no deps and reads no environment.
class Config {
	constructor(readonly dbUrl: string) {}
	static *init() {
		return new Config("sqlite://app.db");
	}
}

// `init` can fail with typed errors — they join E where the class is injected.
const dbError = Errors.define({
	no_url: () => ({ message: "DB_URL is not set" }),
});

class Db {
	constructor(private readonly url: string) {}
	// Async init: awaiting the connect is real setup, and `get` still works.
	static async *init() {
		const config = yield* Services.get(Config);
		if (!config.dbUrl) return yield* Safe.err(dbError.no_url());
		await new Promise((resolve) => setTimeout(resolve, 1)); // stand-in for a connect
		return new Db(config.dbUrl);
	}
	query(sql: string): Promise<string[]> {
		return Promise.resolve([`${sql} @ ${this.url}`]);
	}
	// One name for both arities: the scope awaits whatever `dispose` returns.
	async *dispose() {
		console.log("db: closed");
	}
}

class Mailer {
	constructor(private readonly logger: Logger) {}
	static *init() {
		return new Mailer(yield* Services.get(Logger));
	}
	send(userId: string): Safe<string, never, never> {
		return Safe.call(() => {
			this.logger.info(`sent welcome mail to ${userId}`);
			return `welcome:${userId}`;
		});
	}
}

// What a program gets is what its R asks for.
const createUser = (name: string) =>
	Safe.try(function* () {
		const db = yield* Services.get(Db); // R = typeof Db
		const mailer = yield* Services.get(Mailer); // R = typeof Db | typeof Mailer
		const rows = yield* Safe.call(() => db.query(`insert ${name}`));
		const receipt = yield* mailer.send(name);
		return `${rows[0]} ${receipt}`;
	}); // Safe<string, never, typeof Db | typeof Mailer>

const show = <A, E>(exit: Outcome<A, E>): string => {
	if (exit._tag === "success") return `ok: ${JSON.stringify(exit.value)}`;
	return exit._tag === "fail" ? `fail: ${JSON.stringify(exit.error)}` : exit._tag;
};

// Full wiring. The environment enters here, once — never inside a service.
const { DB_URL } = process.env;
console.log(
	show(
		await Runtime.run(
			Services.provide(createUser("ada"), [
				Db,
				Mailer,
				Services.new(Config, new Config(DB_URL ?? "sqlite://app.db")),
				Logger,
			]),
		),
	),
);

// A failing init is a typed fail — nothing else gets built.
console.log(
	show(
		await Runtime.run(
			Services.provide(createUser("ada"), [
				Db,
				Mailer,
				Services.new(Config, new Config("")),
				Logger,
			]),
		),
	),
);

// The test seam: a subclass instance stands in for Db (no init, no deps, no cleanup).
class MemoryDb extends Db {
	override query(sql: string) {
		return Promise.resolve([`fake ${sql}`]);
	}
}
console.log(
	show(
		await Runtime.run(
			Services.provide(createUser("ada"), [
				Services.new(Db, new MemoryDb("memory://")),
				Mailer,
				Logger,
			]),
		),
	),
);
