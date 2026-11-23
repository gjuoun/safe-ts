import {
	Errors,
	type ErrorsOf,
	type Outcome,
	Pipe,
	Runtime,
	Safe,
	type Scheduler,
} from "../src/index.ts";

const userError = Errors.define({
	not_found: (id: string) => ({ message: `no user with id ${id}`, id }),
});
type UserError = ErrorsOf<typeof userError>;

interface User {
	readonly id: string;
	readonly name: string;
}

class Config {
	constructor(readonly users: Readonly<Record<string, string>>) {}
}

class Db {
	constructor(private readonly config: Config) {}
	get(id: string, scheduler: Scheduler): Promise<string | undefined> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(this.config.users[id]), id === "slow" ? 1000 : 1);
			scheduler.onCancel(() => clearTimeout(timer));
		});
	}
	close() {
		console.log("db: closed");
	}
}

class UserRepo {
	constructor(private readonly db: Db) {}
	find(id: string): Safe<User, UserError> {
		const db = this.db;
		return Safe.try(function* () {
			const name = yield* Safe.call((scheduler) => db.get(id, scheduler));
			if (name === undefined) return yield* Safe.err(userError.not_found(id));
			return { id, name };
		});
	}
}

const config = new Config({ u1: "ada" });
const db = new Db(config);
const repo = new UserRepo(db);

const greet = (id: string) =>
	Safe.try(function* () {
		const user = yield* repo.find(id);
		return `found: ${user.name}`;
	}).pipe(Pipe.catchTag("not_found", (e: { id: string }) => Safe.ok(`handled: not_found ${e.id}`)));

const show = (exit: Outcome<string, never>): string =>
	exit._tag === "success" ? exit.value : exit._tag;

console.log(show(await Runtime.run(greet("u1"))));
console.log(show(await Runtime.run(greet("u2"))));
console.log(show(await Runtime.run(greet("slow"), { signal: AbortSignal.timeout(20) })));
db.close();
