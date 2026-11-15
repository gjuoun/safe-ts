// services.ts — plain classes as services.
//
// A service is an ordinary class with a `static init`. The constructor takes
// what the class needs; `init` gets it. Constructor parameter types are
// erased at runtime, so `init` is where the dependencies are named:
//
//   class Db {
//     constructor(private readonly config: Config) {}
//     static async *init() {
//       const config = yield* get(Config);
//       if (!config.url) return yield* Safe.err(dbError.no_url());
//       return new Db(config);
//     }
//     async *dispose() { … }
//   }
//
// `init` is always a generator (sync or async) driven like a Safe.try body: it
// can `yield*` get(Other) or a Safe and returns the instance. A generator with
// no `yield` is legal — `static *init() { return new Config(url) }`. The classes
// an `init` gets are the class's deps; the failures it yields join E.
//
// `provide(safe, [UserRepo, Db, Config])` removes the listed classes from R
// and adds the deps they leave unprovided. Within one `provide`, each class
// builds once, on first use; `init` is not interruptible. An instance that
// declares `dispose` has it called, last-built first, when the `provide` region
// ends — a generator too, the same shape `init` has.
import { Outcome } from "./outcome.ts";
import {
	type AnyGenerator,
	type Ctx,
	drive,
	exec,
	type Lookup,
	NEVER_ABORTED,
	Safe,
	type YieldError,
	type YieldRequirement,
} from "./safe.ts";
import { type Finalizer, Scope } from "./scope.ts";

/**
 * The shape every service class has: `init` is always a generator, and it takes
 * the run's params — one object, the same one for every class. A class that
 * needs none writes `static *init()`, which is a `ServiceClass<undefined>`.
 */
export interface ServiceClass<P = undefined> {
	init(params: P): AnyGenerator;
}

type InitOut<C> = C extends { init: (...args: never[]) => infer O } ? O : never;
type GenYield<O> =
	O extends Generator<infer Y, any, any>
		? Y
		: O extends AsyncGenerator<infer Y, any, any>
			? Y
			: never;
type GenReturn<O> =
	O extends Generator<any, infer T, any>
		? T
		: O extends AsyncGenerator<any, infer T, any>
			? T
			: never;
/** What `init` finally returns: the generator's return. */
type InitResult<C> = GenReturn<InitOut<C>>;

/** What `get(C)` returns: the instance `init` produced. */
export type Instance<C> = InitResult<C>;

/** The classes `init` gets. */
export type DepsOf<C> = YieldRequirement<GenYield<InitOut<C>>>;

/** The errors `init` can fail with: the failures it yields. */
export type InitError<C> = YieldError<GenYield<InitOut<C>>>;

/** A ready instance standing in for a class (tests, fakes). */
export interface Override<C extends ServiceClass<any>> {
	readonly _tag: "Override";
	readonly service: C;
	readonly instance: Instance<C>;
}

export type Entry = ServiceClass<any> | Override<ServiceClass<any>>;

export type ClassOf<En> = En extends Override<infer C> ? C : En;
export type EntryDeps<En> = En extends Override<ServiceClass<any>> ? never : DepsOf<En>;
export type EntryError<En> = En extends Override<ServiceClass<any>> ? never : InitError<En>;

/** The params an entry's `init` declares: `void` when it takes none. */
export type ParamsOf<C> = C extends { init: (...args: infer A) => AnyGenerator }
	? A extends []
		? undefined
		: A[0]
	: undefined;

/** What `provide` must pass for these entries; `void` when none declares params. */
export type EntryParams<En> = En extends Override<ServiceClass<any>> ? undefined : ParamsOf<En>;

/** The params argument: required exactly when an entry declares one. */
export type ParamsArg<En, Params> = [Exclude<EntryParams<En>, undefined>] extends [never]
	? [params?: Params]
	: [params: Params & EntryParams<En>];

/** Ask for a service inside Safe.try or an `init`: `const db = yield* get(Db)`. */
export function* get<C extends ServiceClass<any>>(service: C): Generator<C, Instance<C>, any> {
	return yield service;
}

/** Use `instance` for class `service` instead of calling its `init`. */
export const override = <C extends ServiceClass<any>>(
	service: C,
	instance: Instance<C>,
): Override<C> => ({ _tag: "Override", service, instance });

/**
 * Satisfy class requirements of `safe` with the listed classes. The params
 * object is handed to every `init`; it is required when any entry declares one.
 */
export const provide = <A, E, R, const P extends readonly Entry[], Params = undefined>(
	safe: Safe<A, E, R>,
	entries: P,
	...rest: ParamsArg<P[number], Params>
): Safe<A, E | EntryError<P[number]>, Exclude<R | EntryDeps<P[number]>, ClassOf<P[number]>>> =>
	new Safe<A, E | EntryError<P[number]>, Exclude<R | EntryDeps<P[number]>, ClassOf<P[number]>>>(
		async (ctx) => {
			const scope = new Scope();
			const lookup = makeLookup(entries, ctx, scope, rest[0]);
			return scope.close(await exec(safe, { ...ctx, lookup }));
		},
	);

const isOverride = (e: Entry): e is Override<ServiceClass<any>> => typeof e !== "function";

export const nameOf = (service: ServiceClass<any>): string =>
	(service as { name?: string }).name || "anonymous";

const isGenerator = (value: unknown): value is AnyGenerator =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { next?: unknown }).next === "function" &&
	typeof (value as { throw?: unknown }).throw === "function";

/**
 * A lookup that builds `entries` on first use (once each) and defers every
 * other class to `ctx.lookup`. Built instances register their `dispose` hook
 * on `scope`.
 */
export const makeLookup = (
	entries: readonly Entry[],
	ctx: Ctx,
	scope: Scope,
	params: unknown,
): Lookup => {
	const own = new Map<ServiceClass<any>, Entry>();
	for (const entry of entries) own.set(isOverride(entry) ? entry.service : entry, entry);
	const memo = new Map<ServiceClass<any>, Promise<Outcome<unknown, unknown>>>();
	const outer = ctx.lookup;

	const lookup: Lookup = (service, path) => {
		const entry = own.get(service);
		if (entry === undefined) return outer(service, path);
		// Checked before the memo: a cycle would otherwise await itself forever.
		if (path.includes(service)) {
			const names = [...path, service].map(nameOf).join(" -> ");
			return Promise.resolve(Outcome.die(new Error(`safe-ts: dependency cycle: ${names}`)));
		}
		let pending = memo.get(service);
		if (pending === undefined) {
			pending = build(entry, [...path, service]);
			memo.set(service, pending);
		}
		return pending;
	};

	const build = async (
		entry: Entry,
		path: readonly ServiceClass<any>[],
	): Promise<Outcome<unknown, unknown>> => {
		if (isOverride(entry)) return Outcome.succeed(entry.instance);
		// init runs uninterruptibly, resolving its dep lookups through this lookup.
		const initCtx: Ctx = { ...ctx, signal: NEVER_ABORTED, lookup, path };
		// `init` is always a generator, so one driver runs every lifecycle body.
		const init = new Safe((c: Ctx) => drive(entry.init(params), c));
		// exec turns a throw from init into a die.
		const exit = await exec(init, initCtx);
		if (exit._tag === "success") {
			const cleanup = disposerOf(exit.value, initCtx);
			if (cleanup) scope.add(cleanup);
		}
		return exit;
	};

	return lookup;
};

/**
 * The instance's `dispose` hook, bound, if it declares one. Like `init`, it is
 * always a generator: `*dispose()` or `async *dispose()`. It is driven by the
 * same driver, so cleanup may `yield* get(Dep)` — the scope closes last-built
 * first, so a dependency is still alive when its dependents clean up. A
 * non-generator `dispose` and a non-success outcome are both thrown, which
 * `Scope.close` records as a defect the way a throwing finalizer is.
 */
const disposerOf = (value: unknown, ctx: Ctx): Finalizer | undefined => {
	if (typeof value !== "object" || value === null) return undefined;
	const hook = (value as { dispose?: unknown }).dispose;
	if (typeof hook !== "function") return undefined;
	return async () => {
		const out = hook.call(value);
		if (!isGenerator(out)) {
			throw new TypeError("safe-ts: dispose must be a generator; write *dispose() { … }");
		}
		// Uninterruptible: a runtime disposing under abort must still clean up.
		const exit = await drive(out, { ...ctx, signal: NEVER_ABORTED });
		if (exit._tag === "success") return;
		throw exit._tag === "fail"
			? exit.error
			: exit._tag === "die"
				? exit.defect
				: new Error("safe-ts: dispose was interrupted");
	};
};
