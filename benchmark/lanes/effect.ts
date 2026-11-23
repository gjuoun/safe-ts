import { Effect } from "effect";

const STORE: Record<string, string> = { u1: "ada" };
const decodeUser = (raw: unknown): { name?: string } => {
	if (typeof raw !== "object" || raw === null) return {};
	const name = "name" in raw ? raw.name : undefined;
	return typeof name === "string" ? { name } : {};
};
const parse = (s: string) =>
	Effect.try({ try: () => decodeUser(JSON.parse(s)), catch: () => "bad_json" });
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
let flakyN = 0;
const flaky = () =>
	Effect.try({
		try: () => {
			flakyN += 1;
			if (flakyN % 3 !== 0) throw new Error("not yet");
			return "ok";
		},
		catch: () => "boom",
	});

export const build = {
	success: () =>
		Effect.gen(function* () {
			const o = yield* parse('{"name":"demo"}');
			const n = yield* lookup("u1");
			return `${n}:${String(o.name)}`;
		}),
	recover: () =>
		Effect.gen(function* () {
			const o = yield* parse('{"name":"demo"}');
			const n = yield* lookup("u2");
			return `${n}:${String(o.name)}`;
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
			return `${n}:${String(o.name)}`;
		}),
	concurrency: () =>
		Effect.gen(function* () {
			const xs: number[] = yield* Effect.all([step(1), step(2), step(3), step(4)]);
			return String(xs.reduce((a, b) => a + b, 0));
		}),
	cleanup: () =>
		Effect.gen(function* () {
			const handle: { open: boolean } = yield* Effect.scoped(
				Effect.acquireRelease(
					Effect.sync(() => ({ open: true })),
					() => Effect.void,
				),
			);
			return handle.open ? "open" : "closed";
		}),
	timeoutBound: () => Effect.sleep("50 millis").pipe(Effect.timeout("1 seconds")),
	delayWait: () =>
		Effect.gen(function* () {
			yield* Effect.sleep("1 millis");
			return "done";
		}),
	retryFlaky: () => flaky().pipe(Effect.retry({ times: 2 })),
	retry_timeout: () => flaky().pipe(Effect.timeout("1 seconds"), Effect.retry({ times: 2 })),
} as const;

export type Name = keyof typeof build;
export const names = Object.keys(build).filter((key): key is Name => key in build);

type OutcomeView = { _tag: string; value?: unknown };
const toOutcome = (raw: unknown): OutcomeView => {
	if (typeof raw !== "object" || raw === null) return { _tag: "fail" };
	const tag = "_tag" in raw ? raw._tag : undefined;
	if (tag !== "Success") return { _tag: "fail" };
	return { _tag: "success", value: "value" in raw ? raw.value : undefined };
};

export const run = async (n: Name) => toOutcome(await Effect.runPromiseExit(build[n]()));
export const runSync = (n: Name) => toOutcome(Effect.runSyncExit(build[n]()));
export const show = (o: { _tag: string; value?: unknown }) =>
	o._tag === "success" ? `ok:${String(o.value)}` : "fail";
