import { all } from "../../src/all.ts";
import { Safe } from "../../src/safe.ts";
import { get } from "../../src/services.ts";
import { assertType, type Equal } from "./assert.ts";

class Db {
	constructor(readonly n: number) {}
	static *init() {
		return new Db(1);
	}
}
const a = Safe.ok(1);
const b = Safe.err("b" as const);
const c = Safe.try(function* () {
	return String((yield* get(Db)).n);
});

const tuple = all([a, b, c] as const);
assertType<Equal<typeof tuple, Safe<readonly [number, never, string], "b", typeof Db>>>();

const literal = all([a, a]);
assertType<Equal<typeof literal, Safe<readonly [number, number], never, never>>>();

const list: Safe<number, "x", never>[] = [a, a];
const arr = all(list);
assertType<Equal<typeof arr, Safe<number[], "x", never>>>();

const viaStatic = Safe.all([a, c] as const);
assertType<Equal<typeof viaStatic, Safe<readonly [number, string], never, typeof Db>>>();
