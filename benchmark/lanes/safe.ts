import { Errors, Pipe, Runtime, Safe } from "../../src/index.ts";

const e = Errors.define({
	bad_json: () => ({ message: "bad json" }),
	not_found: (id: string) => ({ message: `no ${id}`, id }),
	boom: () => ({ message: "boom" }),
});

const STORE: Record<string, string> = { u1: "ada" };
const decodeUser = (raw: unknown): { name?: string } => {
	if (typeof raw !== "object" || raw === null) return {};
	const name = "name" in raw ? raw.name : undefined;
	return typeof name === "string" ? { name } : {};
};
const parse = (s: string) =>
	Safe.call(
		() => decodeUser(JSON.parse(s)),
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
let flakyN = 0;
const flaky = () =>
	Safe.call(
		() => {
			flakyN += 1;
			if (flakyN % 3 !== 0) throw new Error("not yet");
			return "ok";
		},
		() => e.boom(),
	);

export const build = {
	success: () =>
		Safe.try(function* () {
			const o = yield* parse('{"name":"demo"}');
			const n = yield* lookup("u1");
			return `${n}:${String(o.name)}`;
		}),
	recover: () =>
		Safe.try(function* () {
			const o = yield* parse('{"name":"demo"}');
			const n = yield* lookup("u2");
			return `${n}:${String(o.name)}`;
		}).pipe(Pipe.catchTag("not_found", (p: { id: string }) => Safe.ok(`default:${p.id}`))),
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
			return `${n}:${String(o.name)}`;
		}),
	concurrency: () =>
		Safe.try(function* () {
			const xs = yield* Safe.all([step(1), step(2), step(3), step(4)]);
			return String(xs.reduce((a, b) => a + b, 0));
		}),
	cleanup: () =>
		Safe.try(function* () {
			const handle = yield* Safe.defer(
				Safe.call(() => ({ open: true })),
				() => {},
			);
			return handle.open ? "open" : "closed";
		}),
	timeoutBound: () =>
		Safe.try(function* () {
			return yield* Safe.delay(50).pipe(Pipe.timeout(1_000));
		}),
	delayWait: () =>
		Safe.try(function* () {
			yield* Safe.delay(1);
			return "done";
		}),
	retryFlaky: () =>
		Safe.try(function* () {
			return yield* flaky().pipe(Pipe.retry({ attempts: 3 }));
		}),
	retry_timeout: () =>
		Safe.try(function* () {
			return yield* flaky().pipe(Pipe.timeout(1_000), Pipe.retry({ attempts: 3 }));
		}),
} as const;

export type Name = keyof typeof build;
export const names = Object.keys(build).filter((key): key is Name => key in build);
export const run = (n: Name) => Runtime.run(build[n]());
export const show = (o: { _tag: string; value?: unknown }) =>
	o._tag === "success" ? `ok:${String(o.value)}` : "fail";
