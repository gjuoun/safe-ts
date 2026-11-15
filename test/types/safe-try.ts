import { Safe } from "../../src/safe.ts";
import { assertType, type Equal } from "./assert.ts";

declare const num: Safe<number, "nan", never>;
declare const str: Safe<string, "empty", never>;

const sync = Safe.try(function* () {
	const n = yield* num;
	if (n < 0) return yield* Safe.err("negative" as const);
	return String(n);
});
assertType<Equal<typeof sync, Safe<string, "nan" | "negative", never>>>();

const plain = Safe.try(function* () {
	const n = yield* num;
	return n * 2;
});
assertType<Equal<typeof plain, Safe<number, "nan", never>>>();

const async_ = Safe.try(async function* () {
	const n = yield* num;
	const s = yield* str;
	return s.length + n;
});
assertType<Equal<typeof async_, Safe<number, "nan" | "empty", never>>>();

const mixed = Safe.try(function* () {
	const a = yield* Safe.ok(1);
	if (a > 1) yield* Safe.err("io" as const);
	const b = yield* Safe.call(async () => "x");
	return `${b}${a}`;
});
assertType<Equal<typeof mixed, Safe<string, "io", never>>>();

const onlyFail = Safe.try(function* () {
	return yield* Safe.err("nope" as const);
});
assertType<Equal<typeof onlyFail, Safe<never, "nope", never>>>();
