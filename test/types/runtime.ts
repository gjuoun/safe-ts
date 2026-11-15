import type { Outcome } from "../../src/outcome.ts";
import { Runtime } from "../../src/runtime.ts";
import { Safe } from "../../src/safe.ts";
import { get } from "../../src/services.ts";
import { assertType, type Equal } from "./assert.ts";

class Config {
	static *init() {
		return { url: "mem://" };
	}
}

class Db {
	constructor(readonly n: number) {}
	static *init() {
		const config = yield* get(Config);
		if (!config.url) return yield* Safe.err("no_db" as const);
		return new Db(1);
	}
}

class Other {
	static *init() {
		return "other";
	}
}

const rt = Runtime.make([Db, Config]);

const exit = rt.run(
	Safe.try(function* () {
		return (yield* get(Db)).n;
	}),
);
assertType<Equal<typeof exit, Promise<Outcome<number, "no_db">>>>();

const needsOther = Safe.try(function* () {
	return yield* get(Other);
});
// @ts-expect-error Other is not provided by the runtime
rt.run(needsOther);

// @ts-expect-error Db's init gets Config, which the list does not contain
Runtime.make([Db]);
