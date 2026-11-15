// examples/user-service.ts — everything end to end.
//
// Config → Db (disposable) → UserRepo, as plain classes whose `static init`
// gets what the constructor needs, shared through one runtime. Three
// requests: a found user, a not_found recovered with catchTag, and one
// cancelled by its signal through `Scheduler.onCancel`. Disposing the runtime
// closes the database.
//
//   bun run examples/user-service.ts
import {
	Errors,
	type ErrorsOf,
	type Outcome,
	Safe,
	type Scheduler,
	Services,
} from "../src/index.ts";

// --- Errors ---

const userError = Errors.define({
	not_found: (id: string) => ({ message: `no user with id ${id}`, id }),
});
type UserError = ErrorsOf<typeof userError>;

// --- Services ---

interface User {
	readonly id: string;
	readonly name: string;
}

class Config {
	constructor(readonly users: Readonly<Record<string, string>>) {}
	static *init() {
		return new Config({ u1: "ada" });
	}
}

class Db {
	constructor(private readonly config: Config) {}
	static *init() {
		return new Db(yield* Services.get(Config));
	}
	get(id: string, scheduler: Scheduler): Promise<string | undefined> {
		return new Promise((resolve) => {
			// Slow ids simulate a query that outlives its request.
			const timer = setTimeout(() => resolve(this.config.users[id]), id === "slow" ? 1000 : 1);
			scheduler.onCancel(() => clearTimeout(timer));
		});
	}
	async *dispose() {
		console.log("db: closed");
	}
}

class UserRepo {
	constructor(private readonly db: Db) {}
	static *init() {
		return new UserRepo(yield* Services.get(Db));
	}
	find(id: string): Safe<User, UserError, never> {
		const db = this.db;
		return Safe.try(function* () {
			const name = yield* Safe.call((scheduler) => db.get(id, scheduler));
			if (name === undefined) return yield* Safe.err(userError.not_found(id));
			return { id, name };
		});
	}
}

// --- Program ---

const greet = (id: string) =>
	Safe.try(function* () {
		const repo = yield* Services.get(UserRepo);
		const user = yield* repo.find(id);
		return `found: ${user.name}`;
	}).catchTag("not_found", (e) => Safe.ok(`handled: not_found ${e.id}`));

const show = (exit: Outcome<string, never>): string =>
	exit._tag === "success" ? exit.value : exit._tag;

const runtime = Services.runtime([UserRepo, Db, Config]);
console.log(show(await runtime.run(greet("u1"))));
console.log(show(await runtime.run(greet("u2"))));
console.log(show(await runtime.run(greet("slow"), { signal: AbortSignal.timeout(20) })));
await runtime.dispose();
