// The Effect lane: the same ten scenarios, built per call, measured through its
// own Exit entry (runPromiseExit / runSyncExit) — not wrapped in Effect.result.
import { Effect } from "effect";

const STORE: Record<string, string> = { u1: "ada" };
const parse = (s: string) =>
	Effect.try({ try: () => JSON.parse(s) as { name?: string }, catch: () => "bad_json" });
const lookup = (id: string) => (id in STORE ? Effect.succeed(STORE[id]) : Effect.fail("not_found"));
const step = (n: number) => Effect.sync(() => n);
const boom = () =>
	Effect.try({
		try: () => {
			throw new Error("boom");
		},
		catch: () => "boom",
	});
const asyncLookup = () =>
	Effect.tryPromise({ try: () => Promise.resolve(STORE.u1), catch: () => "boom" });

export const build = {
	success: () =>
		Effect.gen(function* () {
			const o = yield* parse('{"name":"demo"}');
			const n = yield* lookup("u1");
			return n + ":" + String(o.name);
		}),
	recover: () =>
		Effect.gen(function* () {
			const o = yield* parse('{"name":"demo"}');
			const n = yield* lookup("u2");
			return n + ":" + String(o.name);
		}).pipe(
			Effect.catch((x: string) =>
				x === "not_found" ? Effect.succeed("default:u2") : Effect.fail(x),
			),
		),
	earlyExit: () =>
		Effect.gen(function* () {
			yield* step(1);
			yield* lookup("u2");
			yield* step(3);
			return "never";
		}),
	pure10: () =>
		Effect.gen(function* () {
			let sum = 0;
			for (let i = 0; i < 10; i++) sum += yield* Effect.succeed(1);
			return String(sum);
		}),
	chain10: () =>
		Effect.gen(function* () {
			let sum = 0;
			for (let i = 0; i < 10; i++) sum += yield* step(1);
			return String(sum);
		}),
	chain20: () =>
		Effect.gen(function* () {
			let sum = 0;
			for (let i = 0; i < 20; i++) sum += yield* step(1);
			return String(sum);
		}),
	thrown: () =>
		Effect.gen(function* () {
			return yield* boom();
		}),
	asyncInSync: () =>
		Effect.gen(function* () {
			const o = yield* parse('{"name":"demo"}');
			const n = yield* asyncLookup();
			return n + ":" + String(o.name);
		}),
	concurrency: () =>
		Effect.gen(function* () {
			const xs = (yield* Effect.all([step(1), step(2), step(3), step(4)])) as number[];
			return String(xs.reduce((a, b) => a + b, 0));
		}),
	cleanup: () =>
		Effect.gen(function* () {
			const handle = (yield* Effect.scoped(
				Effect.acquireRelease(
					Effect.sync(() => ({ open: true })),
					() => Effect.void,
				),
			)) as { open: boolean };
			return handle.open ? "open" : "closed";
		}),
} as const;

export type Name = keyof typeof build;
export const names = Object.keys(build) as Name[];

type Exit = { _tag: string; value?: unknown; cause?: unknown };
const toOutcome = (x: Exit) =>
	x._tag === "Success" ? { _tag: "success", value: x.value } : { _tag: "fail", error: x.cause };

export const run = async (n: Name) => toOutcome((await Effect.runPromiseExit(build[n]())) as Exit);
export const runSync = (n: Name) => toOutcome(Effect.runSyncExit(build[n]()) as Exit);
export const show = (o: { _tag: string; value?: unknown }) =>
	o._tag === "success" ? "ok:" + String(o.value) : "fail";
