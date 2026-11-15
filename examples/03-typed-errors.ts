// examples/03-typed-errors.ts — error catalogs, `catchTag`, fail vs die.
//
// `defineErrors` builds a thiserror-style catalog: one factory per variant,
// the key is the tag and the factory's own payload travels under it.
// `catchTag` on a Safe removes a handled variant from the error type and hands
// the handler that payload. `renderError` prints catalog errors, adding
// `caused by:` when a factory declared `cause`. A throw is a `die`, never a
// `fail` — defects never travel the typed channel.
//
//   bun run examples/03-typed-errors.ts
import { Errors, type ErrorsOf, Outcome, Runtime, Safe, type TaggedError } from "../src/index.ts";

// One factory per variant; the key is the only place the tag is written.
const storageError = Errors.define({
	not_found: (id: string) => ({ message: `no such key: ${id}`, id }),
	unavailable: (reason: unknown) => ({ message: "store is unreachable", cause: reason }),
});
type StorageError = ErrorsOf<typeof storageError>;

const store: Readonly<Record<string, string>> = { readme: "hello" };

// Sync side: a miss is a typed failure, not a thrown exception.
const getObject = (key: string): Safe<string, StorageError, never> => {
	const value = store[key];
	return value === undefined ? Safe.err(storageError.not_found(key)) : Safe.ok(value);
};

// Async side: a rejection becomes a typed failure, with the raw reason as `cause`.
const fetchObject = (key: string): Safe<string, StorageError, never> =>
	Safe.call(
		() =>
			new Promise<string>((_, reject) =>
				setTimeout(() => reject(new Error(`connect ${key}: ECONNREFUSED`)), 1),
			),
		(reason) => storageError.unavailable(reason),
	);

// `catchTag` recovers one variant — `not_found` leaves the error type.
const withFallback = (key: string) =>
	getObject(key).catchTag("not_found", (e) => Safe.ok(`default for ${e.id}`));

const show = <E extends TaggedError>(exit: Outcome<unknown, E>): string => {
	if (exit._tag === "success") return `ok: ${JSON.stringify(exit.value)}`;
	if (Outcome.isFail(exit)) return Errors.render(exit.error);
	if (Outcome.isDie(exit)) return `die: ${String(exit.defect)}`;
	return "interrupt";
};

console.log(show(await Runtime.run(withFallback("readme"))));
console.log(show(await Runtime.run(withFallback("missing"))));
console.log(show(await Runtime.run(fetchObject("readme"))));

// A throw is a defect: `die`, never a typed `fail`.
console.log(
	show(
		await Runtime.run(
			Safe.call(() => {
				throw new Error("boom");
			}),
		),
	),
);
