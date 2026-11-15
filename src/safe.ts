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
import { type ForEachOptions, forEach, type RetryOptions, retry, timeout } from "./combinators.ts";
import type { Arm, CodeOf, Payload } from "./errors.ts";
import { isThenable, Outcome } from "./outcome.ts";
import { NEVER_ABORTED, Scheduler } from "./scheduler.ts";
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
	readonly path: readonly ServiceClass[];
}

/** Find (building on first use) the instance for a class service. */
export type Lookup = (
	service: ServiceClass,
	path: readonly ServiceClass[],
) => Promise<Outcome<unknown, unknown>>;

/** The lookup outside every `provide`: nothing is provided here. */
export const rootLookup: Lookup = async (service) =>
	Outcome.die(
		new Error(`safe-ts: service "${(service as { name?: string }).name}" was not provided`),
	);

/** A signal that never fires: used where work must not be interrupted. */
export { NEVER_ABORTED } from "./scheduler.ts";

export class Safe<A, E, R> {
	readonly _tag = "Safe" as const;
	/** Phantom slots: they only carry the type parameters. */
	declare readonly _A: A;
	declare readonly _E: E;
	declare readonly _R: R;

	/**
	 * @internal Use `run`; call sites never invoke this directly.
	 * A body returns an `Outcome` when it finished synchronously, and a promise
	 * only when something inside it is actually async.
	 */
	constructor(readonly body: (ctx: Ctx) => Outcome<A, E> | Promise<Outcome<A, E>>) {}

	/**
	 * True when this body's promise already converts its own rejection into an
	 * `Outcome` (`Safe.call` does), so `exec` need not add a pass-through hop.
	 * @internal
	 */
	sealed = false;

	/**
	 * The `yield*` protocol: hand the Safe to the driver, complete with the value
	 * it sends back. A plain iterator rather than a generator so `PureSafe` can
	 * narrow it to a zero-yield completion.
	 */
	[Symbol.iterator](): Iterator<Safe<A, E, R>, A, any> {
		return new SafeIterator(this);
	}

	/**
	 * The same delegation for an `async function*` body: `yield*` prefers this
	 * over `Symbol.iterator`, which spares it the async-from-sync conversion on
	 * every hop (measured 425 → 354 ns per hop).
	 */
	[Symbol.asyncIterator](): AsyncIterator<Safe<A, E, R>, A, any> {
		return new SafeAsyncIterator(this);
	}

	// --- Constructors ---

	static ok<A>(value: A): Safe<A, never, never> {
		return new PureSafe(value);
	}

	static err<E>(error: E): Safe<never, E, never> {
		return new Safe(() => Outcome.fail(error));
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
			return new Safe<Awaited<A>, E, never>(() =>
				Outcome.die(
					new TypeError(
						"safe-ts: Safe.call got a generator function; use Safe.try(...) to sequence",
					),
				),
			);
		}
		const call = new Safe<Awaited<A>, E, never>((ctx) => {
			const scheduler = new Scheduler(ctx.signal);
			let result: A | PromiseLike<A>;
			try {
				result = fn(scheduler);
			} catch (thrown) {
				// A throw nobody mapped is a defect, not a typed failure.
				return scheduler.finish(
					mapErr === undefined ? Outcome.die(thrown) : Outcome.fail(mapErr(thrown)),
				);
			}
			if (!isThenable(result)) return scheduler.finish(Outcome.succeed(result as Awaited<A>));
			// The rejection handler lives here, so this promise never rejects and
			// `exec` can hand it straight to the run (see `sealed`).
			return scheduler.settlePending(result as PromiseLike<Awaited<A>>, (s) =>
				fromSettled(s, mapErr),
			);
		});
		call.sealed = true;
		return call;
	}

	/**
	 * Sequence Safes in a generator body. `yield*` runs a Safe (or `get(C)`)
	 * and stops the body on its failure; the body's return value is the success
	 * value. Lazy: nothing runs until `run`, and each `run` runs the body again.
	 *
	 * A plain `yield safe` is the hot-path form: the driver receives the Safe
	 * directly instead of entering `yield*`'s delegation loop, which saves ~26 ns
	 * per yielded step. The value comes back as `TNext`, so it needs a cast —
	 * `const n = (yield getUser(id)) as User`.
	 */
	static try<Y extends Yieldable, T>(
		body: () => Generator<Y, T, any>,
	): Safe<T, YieldError<Y>, YieldRequirement<Y>>;
	static try<Y extends Yieldable, T>(
		body: () => AsyncGenerator<Y, T, any>,
	): Safe<T, YieldError<Y>, YieldRequirement<Y>>;
	static try(body: () => AnyGenerator): Safe<unknown, unknown, unknown> {
		const sequence = new Safe((ctx) => drive(body(), ctx));
		// `drive` converts every async rejection into an Outcome, so `exec` need
		// not wrap the promise it returns (see `sealed`).
		sequence.sealed = true;
		return sequence;
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
		return new Safe<A, E, R>((ctx) => {
			const exit = exec(acquire, { ...ctx, signal: NEVER_ABORTED });
			return isThenable(exit)
				? exit.then((e) => afterAcquire(e, ctx, release))
				: afterAcquire(exit, ctx, release);
		});
	}

	/** Bound a Safe to `ms`; a timeout is an `interrupt` unless `onTimeout` maps it. */
	static timeout<A, E, R>(safe: Safe<A, E, R>, ms: number): Safe<A, E, R>;
	static timeout<A, E, R, E2>(
		safe: Safe<A, E, R>,
		ms: number,
		onTimeout: () => E2,
	): Safe<A, E | E2, R>;
	static timeout<A, E, R, E2>(
		safe: Safe<A, E, R>,
		ms: number,
		onTimeout?: () => E2,
	): Safe<A, E | E2, R> {
		return timeout(safe, ms, onTimeout);
	}

	/** Re-run on a typed failure; a defect or an interrupt is never retried. */
	static retry<A, E, R>(safe: Safe<A, E, R>, options: RetryOptions): Safe<A, E, R> {
		return retry(safe, options);
	}

	/** Run one Safe per item, in order, optionally in batches of `concurrency`. */
	static forEach<A, B, E, R>(
		items: readonly A[],
		f: (item: A, index: number) => Safe<B, E, R>,
		options?: ForEachOptions,
	): Safe<readonly B[], E, R> {
		return forEach(items, f, options);
	}

	/** Run in a fresh scope; its finalizers run (LIFO) as soon as it exits. */
	static scoped<A, E, R>(safe: Safe<A, E, R>): Safe<A, E, R> {
		return new Safe<A, E, R>((ctx) => {
			const scope = new Scope();
			const exit = exec(safe, { ...ctx, scope });
			return isThenable(exit) ? exit.then((e) => scope.close(e)) : scope.close(exit);
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
		return new Safe<A | B, Exclude<E, Arm<E, K>> | E2, R | R2>((ctx) => {
			const exit = exec(this, ctx);
			if (!isThenable(exit)) {
				if (exit._tag === "fail" && hasTag(exit.error, code)) {
					return exec(f(payloadOf(exit.error, code) as Payload<E, K>), ctx);
				}
				return exit as Outcome<A, Exclude<E, Arm<E, K>>>;
			}
			return exit.then((e) => {
				if (e._tag === "fail" && hasTag(e.error, code)) {
					return exec(f(payloadOf(e.error, code) as Payload<E, K>), ctx);
				}
				return e as Outcome<A, Exclude<E, Arm<E, K>>>;
			});
		});
	}
}

// --- Execution ---

/**
 * A success with no effects: it cannot fail, needs no `Ctx` and cannot be
 * interrupted, so `yield* Safe.ok(x)` completes inline instead of
 * round-tripping through the driver (11 ns per step, measured).
 *
 * Borrowed from neverthrow, whose `Ok` iterator returns its value without
 * yielding — the cheap half of its `safeTry` design. Its `Err` half is not
 * borrowable: neverthrow surfaces an Err by leaving the body suspended, so a
 * `finally` never runs; here the driver closes the body and cleanup happens.
 */
class PureSafe<A> extends Safe<A, never, never> {
	constructor(readonly value: A) {
		super(() => Outcome.succeed(value));
	}

	[Symbol.iterator](): Iterator<Safe<A, never, never>, A, any> {
		return new PureIterator(this.value);
	}

	[Symbol.asyncIterator](): AsyncIterator<Safe<A, never, never>, A, any> {
		return new PureAsyncIterator(this.value);
	}
}

/** The async twin of `SafeIterator`: an async body's `yield*` lands here. */
class SafeAsyncIterator<A, E, R> implements AsyncIterator<Safe<A, E, R>, A, any> {
	#yielded = false;
	constructor(private readonly safe: Safe<A, E, R>) {}

	async next(input?: unknown): Promise<IteratorResult<Safe<A, E, R>, A>> {
		if (!this.#yielded) {
			this.#yielded = true;
			return { value: this.safe, done: false };
		}
		return { value: input as A, done: true };
	}

	async return(): Promise<IteratorResult<Safe<A, E, R>, A>> {
		return { value: undefined as A, done: true };
	}
}

/** One yield: the Safe goes out, the driver's value comes back. */
class SafeIterator<A, E, R> implements Iterator<Safe<A, E, R>, A, any> {
	#yielded = false;
	constructor(private readonly safe: Safe<A, E, R>) {}

	next(input?: unknown): IteratorResult<Safe<A, E, R>, A> {
		if (!this.#yielded) {
			this.#yielded = true;
			return { value: this.safe, done: false };
		}
		return { value: input as A, done: true };
	}

	return(): IteratorResult<Safe<A, E, R>, A> {
		return { value: undefined as A, done: true };
	}
}

/** The async twin of `PureIterator`: still zero-yield. */
class PureAsyncIterator<A> implements AsyncIterator<Safe<A, never, never>, A, any> {
	constructor(private readonly value: A) {}

	async next(): Promise<IteratorResult<Safe<A, never, never>, A>> {
		return { value: this.value, done: true };
	}

	async return(): Promise<IteratorResult<Safe<A, never, never>, A>> {
		return { value: this.value, done: true };
	}
}

/** Completes the delegation on the first `next()`: no yield, no result churn. */
class PureIterator<A> implements Iterator<Safe<A, never, never>, A, any> {
	constructor(private readonly value: A) {}

	next(): IteratorResult<Safe<A, never, never>, A> {
		return { value: this.value, done: true };
	}

	return(): IteratorResult<Safe<A, never, never>, A> {
		return { value: this.value, done: true };
	}
}

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
export const exec = <A, E>(
	safe: Safe<A, E, unknown>,
	ctx: Ctx,
): Outcome<A, E> | Promise<Outcome<A, E>> => {
	if (ctx.signal.aborted) return Outcome.interrupt();
	let out: Outcome<A, E> | Promise<Outcome<A, E>>;
	try {
		out = safe.body(ctx);
	} catch (defect) {
		return Outcome.die(defect);
	}
	// A rejection is a defect, exactly as a throw from the body is. A sealed body
	// already did that conversion, so wrapping it again is a wasted hop.
	if (!isThenable(out)) return out;
	return safe.sealed
		? out
		: out.then(
				(o) => o,
				(defect) => Outcome.die(defect),
			);
};

/** What `Scheduler.settle` reported, in `Safe.call`'s vocabulary. */
const fromSettled = <A, E>(
	settled: Outcome<A, unknown>,
	mapErr?: (thrown: unknown) => E,
): Outcome<A, E> => {
	switch (settled._tag) {
		case "success":
			return settled;
		case "fail":
			return mapErr === undefined
				? Outcome.die(settled.error)
				: Outcome.fail(mapErr(settled.error));
		case "die":
			return Outcome.die(settled.defect);
		case "interrupt":
			return Outcome.interrupt();
	}
};

/** Register the release once the resource exists; nothing runs on failure. */
const afterAcquire = <A, E>(
	exit: Outcome<A, E>,
	ctx: Ctx,
	release: (resource: A, exit: Outcome<unknown, unknown>) => void | PromiseLike<void>,
): Outcome<A, E> => {
	if (exit._tag !== "success") return exit;
	ctx.scope.add((scopeOutcome) => release(exit.value, scopeOutcome));
	return ctx.signal.aborted ? Outcome.interrupt() : exit;
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
	// No signal given: a shared, never-aborted one. A fresh AbortController per
	// run costs ~134 ns and is indistinguishable from this (nothing can abort it).
	const exit = exec(safe, {
		signal: options.signal ?? NEVER_ABORTED,
		scope: root,
		lookup: rootLookup,
		path: [],
	});
	return isThenable(exit) ? exit.then((o) => root.close(o)) : Promise.resolve(root.close(exit));
};

// --- Sequencing ---

/** Anything `yield*`-able inside `Safe.try`. */
export type Yieldable = Safe<any, any, any> | ServiceClass;

export type YieldError<Y> = Y extends Safe<any, infer E, any> ? E : never;

export type YieldRequirement<Y> =
	Y extends Safe<any, any, infer R> ? R : Y extends ServiceClass ? Y : never;

export type AnyGenerator =
	| Generator<unknown, unknown, unknown>
	| AsyncGenerator<unknown, unknown, unknown>;

/**
 * One driver for both kinds. The sync loop handles a generator whose steps all
 * resolve to values — the common case — without allocating a promise per step;
 * the moment a step is a promise (an async generator, or a service lookup) the
 * async continuation takes over and the rest of the body runs there.
 */
export const drive = (
	it: AnyGenerator,
	ctx: Ctx,
): Outcome<unknown, unknown> | Promise<Outcome<unknown, unknown>> => {
	let input: unknown;
	for (;;) {
		if (ctx.signal.aborted) return close(it, Outcome.interrupt());
		// A throw from the body propagates to `exec`, which makes it a `die`.
		const step = it.next(input);
		if (isThenable(step)) return driveFromStep(it, ctx, step);
		if (step.done) return Outcome.succeed(step.value);
		const resolved = resolveYield(step.value, ctx);
		if (isThenable(resolved)) return driveFromYield(it, ctx, resolved);
		if (resolved._tag !== "success") return close(it, resolved);
		input = resolved.value;
	}
};

/**
 * The sync loop, entered once a promise has already resolved: every suspension
 * resumes here rather than in an `async` function, which is how Effect's fiber
 * avoids paying for an extra promise per resumption.
 */
const driveResolved = (
	it: AnyGenerator,
	ctx: Ctx,
	first: Outcome<unknown, unknown>,
): Outcome<unknown, unknown> | Promise<Outcome<unknown, unknown>> => {
	let resolved = first;
	for (;;) {
		if (ctx.signal.aborted) return close(it, Outcome.interrupt());
		if (resolved._tag !== "success") return close(it, resolved);
		const step = it.next(resolved.value);
		if (isThenable(step)) return driveFromStep(it, ctx, step);
		if (step.done) return Outcome.succeed(step.value);
		const next = resolveYield(step.value, ctx);
		if (isThenable(next)) return driveFromYield(it, ctx, next);
		resolved = next;
	}
};

/** Continue in async mode: the next generator step was a promise. */
const driveFromStep = (
	it: AnyGenerator,
	ctx: Ctx,
	pending: PromiseLike<IteratorResult<unknown, unknown>>,
): Promise<Outcome<unknown, unknown>> =>
	Promise.resolve(pending).then(
		(step) => {
			if (step.done) return Outcome.succeed(step.value);
			const resolved = resolveYield(step.value, ctx);
			return isThenable(resolved)
				? driveFromYield(it, ctx, resolved)
				: driveResolved(it, ctx, resolved);
		},
		// A rejecting generator step is a defect, exactly as a sync throw is.
		(defect) => Outcome.die(defect),
	);

/** Continue in async mode: a yielded value resolved to a promise. */
const driveFromYield = (
	it: AnyGenerator,
	ctx: Ctx,
	pending: PromiseLike<Outcome<unknown, unknown>>,
): Promise<Outcome<unknown, unknown>> =>
	Promise.resolve(pending).then(
		(resolved) => driveResolved(it, ctx, resolved),
		(defect) => Outcome.die(defect),
	);

/**
 * Close a suspended generator so its `finally` blocks run. A throw from one is
 * captured and applied only when the outcome was a success — the rule
 * `Scope.close` already uses, so a body that failed keeps its declared error
 * instead of having it overwritten by the cleanup.
 */
const close = (
	it: AnyGenerator,
	outcome: Outcome<unknown, unknown>,
): Outcome<unknown, unknown> | Promise<Outcome<unknown, unknown>> => {
	let defect: { readonly value: unknown } | undefined;
	for (;;) {
		let closed: IteratorResult<unknown, unknown>;
		try {
			closed = it.return(undefined) as IteratorResult<unknown, unknown>;
		} catch (thrown) {
			defect ??= { value: thrown };
			break;
		}
		if (isThenable(closed)) return closeAsync(it, outcome, defect);
		if (closed.done) break;
	}
	return closedOutcome(outcome, defect);
};

/** The async continuation of `close`: an async generator's `return` is a promise. */
const closeAsync = async (
	it: AnyGenerator,
	outcome: Outcome<unknown, unknown>,
	defect: { readonly value: unknown } | undefined,
): Promise<Outcome<unknown, unknown>> => {
	for (;;) {
		try {
			const closed = await it.return(undefined);
			if (closed.done) break;
		} catch (thrown) {
			defect ??= { value: thrown };
			break;
		}
	}
	return closedOutcome(outcome, defect);
};

/** A throwing cleanup is a defect only when the outcome was a success. */
const closedOutcome = (
	outcome: Outcome<unknown, unknown>,
	defect: { readonly value: unknown } | undefined,
): Outcome<unknown, unknown> =>
	defect !== undefined && outcome._tag === "success" ? Outcome.die(defect.value) : outcome;

const isServiceClass = (y: unknown): y is ServiceClass =>
	typeof y === "function" && typeof (y as { init?: unknown }).init === "function";

/**
 * A yielded value resolves to the Outcome that ends the body when it is not a
 * success; a success continues with `out.value`. Returning the Outcome itself
 * (rather than a wrapper object) keeps one allocation out of every yield.
 */
const resolveYield = (
	y: unknown,
	ctx: Ctx,
): Outcome<unknown, unknown> | Promise<Outcome<unknown, unknown>> => {
	if (y instanceof Safe) return exec(y, ctx);
	if (isServiceClass(y)) return ctx.lookup(y, ctx.path);
	return Outcome.die(new TypeError("safe-ts: Safe.try yielded a value that is not yieldable"));
};
