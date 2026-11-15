import { type Arm, defineErrors, type ErrorsOf } from "../../src/errors.ts";
import { Pipe } from "../../src/index.ts";
import type { Outcome } from "../../src/outcome.ts";
import { run, Safe } from "../../src/safe.ts";
import { assertType, type Equal } from "./assert.ts";

const userError = defineErrors({
	not_found: (id: string) => ({ message: `no user ${id}`, id }),
	invalid: (reason: string) => ({ message: reason }),
});
type UserError = ErrorsOf<typeof userError>;

declare const parsed: Safe<number, "nan", never>;
const find = (id: string): Safe<string, UserError, never> =>
	id === "u1" ? Safe.ok("ada") : Safe.err(userError.not_found(id));

const prog = Safe.try(function* () {
	const n = yield* parsed;
	const name = yield* find("u1");
	const upper = yield* Safe.call(() => name.toUpperCase());
	return `${upper}:${n}`;
});
assertType<Equal<typeof prog, Safe<string, "nan" | UserError, never>>>();

const exit = run(prog);
assertType<Equal<typeof exit, Promise<Outcome<string, "nan" | UserError>>>>();

const handled = Safe.pipe(prog, [
	Pipe.catchTag("not_found", (e: { id: string }) => Safe.ok(`guest:${e.id}`)),
]);
assertType<Equal<typeof handled, Safe<string, "nan" | Arm<UserError, "invalid">, never>>>();

// The generator is the combinator: sequencing is `yield*`, not `andThen`.
const chained = Safe.try(function* () {
	const name = yield* find("u1");
	return name.length;
});
assertType<Equal<typeof chained, Safe<number, UserError, never>>>();

const mapped = Safe.try(function* () {
	const n = yield* Safe.call(
		async () => 1,
		() => "io" as const,
	);
	return String(n);
});
assertType<Equal<typeof mapped, Safe<string, "io", never>>>();

// Pipe-position catchTag cannot see the target's E: an unknown code compiles
// and simply never matches — the data-last trade-off.
Safe.pipe(prog, [Pipe.catchTag("missing", () => Safe.ok(""))]);

// The mapper rule at the type level: omit it and E stays `never`.
const tryNoMapper = Safe.call(() => JSON.parse("{}") as { name: string });
assertType<Equal<typeof tryNoMapper, Safe<{ name: string }, never, never>>>();

const tryMapped = Safe.call(
	() => 1,
	(): "bad" => "bad",
);
assertType<Equal<typeof tryMapped, Safe<number, "bad", never>>>();

const promiseNoMapper = Safe.call(async () => 1);
assertType<Equal<typeof promiseNoMapper, Safe<number, never, never>>>();

const promiseMapped = Safe.call(
	async () => 1,
	(): "io" => "io",
);
assertType<Equal<typeof promiseMapped, Safe<number, "io", never>>>();
