import {
	Errors,
	type ErrorsOf,
	Outcome,
	Pipe,
	Runtime,
	Safe,
	type TaggedError,
} from "../src/index.ts";

const storageError = Errors.define({
	not_found: (id: string) => ({ message: `no such key: ${id}`, id }),
	unavailable: (reason: unknown) => ({ message: "store is unreachable", cause: reason }),
});
type StorageError = ErrorsOf<typeof storageError>;

const store: Readonly<Record<string, string>> = { readme: "hello" };

const getObject = (key: string): Safe<string, StorageError> => {
	const value = store[key];
	return value === undefined ? Safe.err(storageError.not_found(key)) : Safe.ok(value);
};

const fetchObject = (key: string): Safe<string, StorageError> =>
	Safe.call(
		() =>
			new Promise<string>((_, reject) =>
				setTimeout(() => reject(new Error(`connect ${key}: ECONNREFUSED`)), 1),
			),
		(reason) => storageError.unavailable(reason),
	);

const withFallback = (key: string) =>
	getObject(key).pipe(
		Pipe.catchTag("not_found", (e: { id: string }) => Safe.ok(`default for ${e.id}`)),
	);

const show = <E extends TaggedError>(exit: Outcome<unknown, E>): string => {
	if (exit._tag === "success") return `ok: ${JSON.stringify(exit.value)}`;
	if (Outcome.isFail(exit)) return Errors.render(exit.error);
	if (Outcome.isDie(exit)) return `die: ${String(exit.defect)}`;
	return "interrupt";
};

console.log(show(await Runtime.run(withFallback("readme"))));
console.log(show(await Runtime.run(withFallback("missing"))));
console.log(show(await Runtime.run(fetchObject("readme"))));

console.log(
	show(
		await Runtime.run(
			Safe.call(() => {
				throw new Error("boom");
			}),
		),
	),
);
