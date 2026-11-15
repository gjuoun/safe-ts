import { all } from "../../src/all.ts";
import { Safe } from "../../src/safe.ts";
import { assertType, type Equal } from "./assert.ts";

const a = Safe.ok(1);
const b = Safe.err("b" as const);
const c = Safe.try(function* () {
	return String(yield* Safe.ok(1));
});

const tuple = all([a, b, c] as const);
assertType<Equal<typeof tuple, Safe<readonly [number, never, string], "b">>>();

const literal = all([a, a]);
assertType<Equal<typeof literal, Safe<readonly [number, number], never>>>();

const list: Safe<number, "x">[] = [a, a];
const arr = all(list);
assertType<Equal<typeof arr, Safe<number[], "x">>>();

const viaStatic = Safe.all([a, c] as const);
assertType<Equal<typeof viaStatic, Safe<readonly [number, string], never>>>();
