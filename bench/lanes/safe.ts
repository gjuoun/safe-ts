// The safe-ts lane: ten scenarios, each built per call (the like-for-like model —
// Effect's gen is lazy too, so both lanes pay construction).
import { Errors, Runtime, Safe } from "../../src/index.ts";

const e = Errors.define({
	bad_json: () => ({ message: "bad json" }),
	not_found: (id: string) => ({ message: "no " + id, id }),
	boom: () => ({ message: "boom" }),
});

const STORE: Record<string, string> = { u1: "ada" };
const parse = (s: string) =>
	Safe.call(
		() => JSON.parse(s) as { name?: string },
		() => e.bad_json(),
	);
const lookup = (id: string) => (id in STORE ? Safe.ok(STORE[id]) : Safe.err(e.not_found(id)));
const step = (n: number) => Safe.call(() => n);
const boom = () =>
	Safe.call(
		() => {
			throw new Error("boom");
		},
		() => e.boom(),
	);
const asyncLookup = () =>
	Safe.call(
		async () => {
			const v = await Promise.resolve(STORE.u1);
			if (v === undefined) throw new Error("missing");
			return v;
		},
		() => e.boom(),
	);

export const build = {
	success: () =>
		Safe.try(function* () {
			const o = yield* parse('{"name":"demo"}');
			const n = yield* lookup("u1");
			return n + ":" + String(o.name);
		}),
	recover: () =>
		Safe.try(function* () {
			const o = yield* parse('{"name":"demo"}');
			const n = yield* lookup("u2");
			return n + ":" + String(o.name);
		}).catchTag("not_found", (p) => Safe.ok("default:" + p.id)),
	earlyExit: () =>
		Safe.try(function* () {
			yield* step(1);
			yield* lookup("u2");
			yield* step(3);
			return "never";
		}),
	pure10: () =>
		Safe.try(function* () {
			let sum = 0;
			for (let i = 0; i < 10; i++) sum += yield* Safe.ok(1);
			return String(sum);
		}),
	chain10: () =>
		Safe.try(function* () {
			let sum = 0;
			for (let i = 0; i < 10; i++) sum += yield* step(1);
			return String(sum);
		}),
	chain20: () =>
		Safe.try(function* () {
			let sum = 0;
			for (let i = 0; i < 20; i++) sum += yield* step(1);
			return String(sum);
		}),
	thrown: () =>
		Safe.try(function* () {
			return yield* boom();
		}),
	asyncInSync: () =>
		Safe.try(function* () {
			const o = yield* parse('{"name":"demo"}');
			const n = yield* asyncLookup();
			return n + ":" + String(o.name);
		}),
	concurrency: () =>
		Safe.try(function* () {
			const xs = yield* Safe.all([step(1), step(2), step(3), step(4)]);
			return String(xs.reduce((a, b) => a + b, 0));
		}),
	cleanup: () =>
		Safe.try(function* () {
			const handle = yield* Safe.scoped(
				Safe.acquireRelease(
					Safe.call(() => ({ open: true })),
					() => {},
				),
			);
			return handle.open ? "open" : "closed";
		}),
} as const;

export type Name = keyof typeof build;
export const names = Object.keys(build) as Name[];
export const run = (n: Name) => Runtime.run(build[n]());
export const show = (o: { _tag: string; value?: unknown }) =>
	o._tag === "success" ? "ok:" + String(o.value) : "fail";
