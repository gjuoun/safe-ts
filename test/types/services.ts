import { run, Safe } from "../../src/safe.ts";
import {
	type DepsOf,
	get,
	type InitError,
	type Instance,
	override,
	provide,
} from "../../src/services.ts";
import { assertType, type Equal } from "./assert.ts";

class Config {
	constructor(readonly url: string) {}
	static *init() {
		return new Config("mem://");
	}
}

class Db {
	constructor(readonly url: string) {}
	static async *init() {
		const config = yield* get(Config);
		if (!config.url) return yield* Safe.err({ code: "no_url" as const });
		const ready = yield* Safe.call(async () => true);
		if (!ready) yield* Safe.err({ code: "not_ready" as const });
		return new Db(config.url);
	}
	query(q: string) {
		return [`${this.url}:${q}`];
	}
}

class UserRepo {
	constructor(private readonly db: Db) {}
	static *init() {
		return new UserRepo(yield* get(Db));
	}
	names() {
		return this.db.query("names");
	}
}

class Settings {
	static async *init() {
		return { debug: false };
	}
}

// `init` is always a generator: a plain function is not a service class.
class PlainInit {
	static init() {
		return new PlainInit();
	}
}

// @ts-expect-error a plain init is not a service class
provide(Safe.ok(1), [PlainInit]);

// Params are a build input: an entry that declares them requires the argument.
class NeedsParams {
	constructor(readonly url: string) {}
	static *init(params: { url: string }) {
		return new NeedsParams(params.url);
	}
}

// @ts-expect-error a params-taking entry requires the params argument
provide(Safe.ok(1), [NeedsParams]);

// @ts-expect-error the params must match what init declares
provide(Safe.ok(1), [NeedsParams], { url: 1 });

const paramsProvided = provide(Safe.ok(1), [NeedsParams], { url: "x" });
assertType<Equal<typeof paramsProvided, Safe<number, never, never>>>();

assertType<Equal<Instance<typeof Config>, Config>>();
assertType<Equal<Instance<typeof Db>, Db>>();
assertType<Equal<Instance<typeof UserRepo>, UserRepo>>();
assertType<Equal<Instance<typeof Settings>, { debug: boolean }>>();
assertType<Equal<DepsOf<typeof Config>, never>>();
assertType<Equal<DepsOf<typeof Db>, typeof Config>>();
assertType<Equal<DepsOf<typeof UserRepo>, typeof Db>>();
assertType<Equal<InitError<typeof Db>, { code: "no_url" } | { code: "not_ready" }>>();
assertType<Equal<InitError<typeof UserRepo>, never>>();

const program = Safe.try(function* () {
	const repo = yield* get(UserRepo);
	const db = yield* get(Db);
	assertType<Equal<typeof repo, UserRepo>>();
	if (db.query("x").length === 0) return yield* Safe.err("empty" as const);
	return repo.names();
});
assertType<Equal<typeof program, Safe<string[], "empty", typeof UserRepo | typeof Db>>>();

type DbErr = { code: "no_url" } | { code: "not_ready" };

const wired = provide(program, [UserRepo, Db, Config]);
assertType<Equal<typeof wired, Safe<string[], "empty" | DbErr, never>>>();
run(wired);

const partial = provide(program, [UserRepo, Db]);
assertType<Equal<typeof partial, Safe<string[], "empty" | DbErr, typeof Config>>>();

const nested = provide(partial, [Config]);
assertType<Equal<typeof nested, Safe<string[], "empty" | DbErr, never>>>();

const faked = provide(program, [UserRepo, override(Db, new Db("fake://"))]);
assertType<Equal<typeof faked, Safe<string[], "empty", never>>>();

export const typeOnly = () => {
	// @ts-expect-error Config is still required
	run(provide(program, [UserRepo, Db]));
	// @ts-expect-error an override must be an instance of the class
	override(Db, { url: 1 });
};
