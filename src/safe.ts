// safe.ts — the core type: a lazy Safe<A, E, R>.
//
// A Safe is a description of work: nothing runs until `run`. It succeeds with
// A, fails with a typed E, and needs the services in R (a union of service
// classes, see services.ts). `run` only accepts R = never, so a missing
// service is a compile error rather than a runtime "service not found".
//
// Every child Safe executes through `exec`, the one place that catches a throw
// from a Safe.try body or a service `init`. `Safe.call` catches its own call, so
// a throw nobody mapped is a `die`, never a typed `fail`.
import { type AllA, type AllE, type AllR, all } from "./all.ts";
import type { Arm, CodeOf, Payload } from "./errors.ts";
import { Outcome } from "./outcome.ts";
import { Scheduler } from "./scheduler.ts";
import { Scope } from "./scope.ts";
import type { ServiceClass } from "./services.ts";

/** Runtime context threaded through every Safe of one run. Internal. */
export interface Ctx {
	readonly signal: AbortSignal;
	/** Where finalizers registered now are attached. */
	readonly scope: Scope;
	/** Resolves a class service to its instance (see services.ts). */
	readonly lookup: Lookup;
	/** Classes whose `init` is running, outermost first (cycle detection). */
	readonly path: readonly ServiceClass<any>[];
}

/** Find (building on first use) the instance for a class service. */
export type Lookup = (
	service: ServiceClass<any>,
	path: readonly ServiceClass<any>[],
) => Promise<Outcome<unknown, unknown>>;

/** The lookup outside every `provide`: nothing is provided here. */
export const rootLookup: Lookup = async (service) =>
	Outcome.die(
		new Error(`safe-ts: service "${(service as { name?: string }).name}" was not provided`),
	);

/** A signal that never fires: used where work must not be interrupted. */
export const NEVER_ABORTED: AbortSignal = new AbortController().signal;

export class Safe<A, E, R> {
	readonly _tag = "Safe" as const;
	/** Phantom slots: they only carry the type parameters. */
	declare readonly _A: A;
	declare readonly _E: E;
	declare readonly _R: R;

	/** @internal Use `run`; call sites never invoke this directly. */
	constructor(readonly body: (ctx: Ctx) => Promise<Outcome<A, E>>) {}

	*[Symbol.iterator](): Generator<Safe<A, E, R>, A, any> {
		return yield this;
	}

	// --- Constructors ---

	static ok<A>(value: A): Safe<A, never, never> {
		return new Safe(async () => Outcome.succeed(value));
	}

	static err<E>(error: E): Safe<never, E, never> {
		return new Safe(async () => Outcome.fail(error));
	}

	/**
	 * Run a function — sync or async — against the run's cancellation. Declare
	 * `mapErr` and a throw or rejection becomes `fail(mapErr(thrown))`; omit it
	 * and it is a defect (`die`). `fn` receives the run's Scheduler.
	 */
	static call<A>(fn: (scheduler: Scheduler) => A | PromiseLike<A>): Safe<Awaited<A>, never, never>;
	static call<A, E>(
		fn: (scheduler: Scheduler) => A | PromiseLike<A>,
		mapErr: (thrown: unknown) => E,
	): Safe<Awaited<A>, E, never>;
	static call<A, E>(
		fn: (scheduler: Scheduler) => A | PromiseLike<A>,
		mapErr?: (thrown: unknown) => E,
	): Safe<Awaited<A>, E, never> {
		if (isGeneratorFunction(fn)) {
			return new Safe<Awaited<A>, E, never>(async () =>
				Outcome.die(
					new TypeError(
						"safe-ts: Safe.call got a generator function; use Safe.try(...) to sequence",
					),
				),
			);
		}
		return new Safe<Awaited<A>, E, never>(async (ctx) => {
			const scheduler = new Scheduler(ctx.signal);
			const settled = await scheduler.settle(() => fn(scheduler));
			switch (settled._tag) {
				case "success":
					return Outcome.succeed(settled.value);
				case "fail":
					return mapErr === undefined
						? Outcome.die(settled.error)
						: Outcome.fail(mapErr(settled.error));
				case "die":
					return Outcome.die(settled.defect);
				case "interrupt":
					return Outcome.interrupt();
			}
		});
	}

	/**
	 * Sequence Safes in a generator body. `yield*` runs a Safe (or `get(C)`)
	 * and stops the body on its failure; the body's return value is the success
	 * value. Lazy: nothing runs until `run`, and each `run` runs the body again.
	 */
	static try<Y extends Yieldable, T>(
		body: () => Generator<Y, T, any>,
	): Safe<T, YieldError<Y>, YieldRequirement<Y>>;
	static try<Y extends Yieldable, T>(
		body: () => AsyncGenerator<Y, T, any>,
	): Safe<T, YieldError<Y>, YieldRequirement<Y>>;
	static try(body: () => AnyGenerator): Safe<unknown, unknown, unknown> {
		return new Safe((ctx) => drive(body(), ctx));
	}

	/**
	 * Run Safes concurrently, keeping order. The first fail or die aborts the
	 * rest and becomes the result.
	 */
	static all<const T extends readonly Safe<any, any, any>[]>(
		safes: T,
	): Safe<AllA<T>, AllE<T>, AllR<T>> {
		return all(safes);
	}

	/**
	 * Acquire a resource and register its release on the current scope. The
	 * acquire step is not interruptible, so an acquired resource is always
	 * released. `release` gets the scope's outcome.
	 */
	static acquireRelease<A, E, R>(
		acquire: Safe<A, E, R>,
		release: (resource: A, exit: Outcome<unknown, unknown>) => void | PromiseLike<void>,
	): Safe<A, E, R> {
		return new Safe<A, E, R>(async (ctx) => {
			const exit = await exec(acquire, { ...ctx, signal: NEVER_ABORTED });
			if (exit._tag !== "success") return exit;
			ctx.scope.add((scopeOutcome) => release(exit.value, scopeOutcome));
			return ctx.signal.aborted ? Outcome.interrupt() : exit;
		});
	}

	/** Run in a fresh scope; its finalizers run (LIFO) as soon as it exits. */
	static scoped<A, E, R>(safe: Safe<A, E, R>): Safe<A, E, R> {
		return new Safe<A, E, R>(async (ctx) => {
			const scope = new Scope();
			return scope.close(await exec(safe, { ...ctx, scope }));
		});
	}

	// --- Combinators ---

	/**
	 * Recover from one typed error variant by its key. The handler gets the
	 * factory's payload; defects pass through.
	 */
	catchTag<const K extends CodeOf<E>, B, E2 = never, R2 = never>(
		code: K,
		f: (payload: Payload<E, K>) => Safe<B, E2, R2>,
	): Safe<A | B, Exclude<E, Arm<E, K>> | E2, R | R2> {
		return new Safe<A | B, Exclude<E, Arm<E, K>> | E2, R | R2>(async (ctx) => {
			const exit = await exec(this, ctx);
			if (exit._tag === "fail" && hasTag(exit.error, code)) {
				return exec(f(payloadOf(exit.error, code) as Payload<E, K>), ctx);
			}
			return exit as Outcome<A, Exclude<E, Arm<E, K>>>;
		});
	}
}

// --- Execution ---

/** A generator function belongs to `Safe.try`, not `Safe.call`. */
const isGeneratorFunction = (fn: unknown): boolean => {
	const tag = Object.prototype.toString.call(fn);
	return tag === "[object GeneratorFunction]" || tag === "[object AsyncGeneratorFunction]";
};

/** A catalog error is a one-key record: the tag is the key, not a field. */
const hasTag = (e: unknown, code: string): boolean =>
	typeof e === "object" && e !== null && code in e;

/** The arm's value: what the factory returned. */
const payloadOf = (e: unknown, code: string): unknown =>
	typeof e === "object" && e !== null ? (e as Record<string, unknown>)[code] : undefined;

/**
 * Execute one Safe in a context. Together with `Safe.call`, one of the two
 * places a throw is classified: anything that escapes a body or a service
 * `init` is a defect. An already-aborted signal stops work before it starts.
 */
export const exec = async <A, E>(safe: Safe<A, E, unknown>, ctx: Ctx): Promise<Outcome<A, E>> => {
	if (ctx.signal.aborted) return Outcome.interrupt();
	try {
		return await safe.body(ctx);
	} catch (defect) {
		return Outcome.die(defect);
	}
};

export interface RunOptions {
	/** Aborting this signal interrupts the run. */
	readonly signal?: AbortSignal;
}

/**
 * Run a Safe whose requirements are all provided (R = never). Never rejects:
 * every outcome, including defects, is an Outcome.
 */
export const run = async <A, E>(
	safe: Safe<A, E, never>,
	options: RunOptions = {},
): Promise<Outcome<A, E>> => {
	const root = new Scope();
	const exit = await exec(safe, {
		signal: options.signal ?? new AbortController().signal,
		scope: root,
		lookup: rootLookup,
		path: [],
	});
	return root.close(exit);
};

// --- Sequencing ---

/** Anything `yield*`-able inside `Safe.try`. */
export type Yieldable = Safe<any, any, any> | ServiceClass<any>;

export type YieldError<Y> = Y extends Safe<any, infer E, any> ? E : never;

export type YieldRequirement<Y> =
	Y extends Safe<any, any, infer R> ? R : Y extends ServiceClass<any> ? Y : never;

export type AnyGenerator =
	| Generator<unknown, unknown, unknown>
	| AsyncGenerator<unknown, unknown, unknown>;

/** One driver for both kinds: `await` on a sync step is a no-op. */
export const drive = async (it: AnyGenerator, ctx: Ctx): Promise<Outcome<unknown, unknown>> => {
	let input: unknown;
	while (true) {
		if (ctx.signal.aborted) return close(it, Outcome.interrupt());
		// A throw from the body propagates to `exec`, which makes it a `die`.
		const step = await it.next(input);
		if (step.done) return Outcome.succeed(step.value);
		const resolved = await resolveYield(step.value, ctx);
		if ("stop" in resolved) return close(it, resolved.stop);
		input = resolved.next;
	}
};

/**
 * Close a suspended generator so its `finally` blocks run. A throw from one is
 * captured and applied only when the outcome was a success — the rule
 * `Scope.close` already uses, so a body that failed keeps its declared error
 * instead of having it overwritten by the cleanup.
 */
const close = async (it: AnyGenerator, outcome: Outcome<never, unknown>) => {
	let defect: { readonly value: unknown } | undefined;
	while (true) {
		try {
			const closed = await it.return(undefined);
			if (closed.done) break;
		} catch (thrown) {
			defect ??= { value: thrown };
			break;
		}
	}
	return defect !== undefined && outcome._tag === "success" ? Outcome.die(defect.value) : outcome;
};

type Step = { readonly next: unknown } | { readonly stop: Outcome<never, unknown> };

const isServiceClass = (y: unknown): y is ServiceClass<any> =>
	typeof y === "function" && typeof (y as { init?: unknown }).init === "function";

const resolveYield = async (y: unknown, ctx: Ctx): Promise<Step> => {
	if (y instanceof Safe) {
		const out = await exec(y, ctx);
		return out._tag === "success" ? { next: out.value } : { stop: out };
	}
	if (isServiceClass(y)) {
		const out = await ctx.lookup(y, ctx.path);
		return out._tag === "success" ? { next: out.value } : { stop: out };
	}
	return {
		stop: Outcome.die(new TypeError("safe-ts: Safe.try yielded a value that is not yieldable")),
	};
};
