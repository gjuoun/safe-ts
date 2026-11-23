import { type AllA, type AllE, type AllSettledA, all, allSettled } from "./all.ts";
import { type Clock, Clocks } from "./clock.ts";
import { delay, type ForEachOptions, forEach, type RaceOptions, race } from "./combinators.ts";
import type { Arm } from "./errors.ts";
import { isThenable, Outcome } from "./outcome.ts";
import { CallScheduler, NEVER_ABORTED, type Scheduler } from "./scheduler.ts";
import { Scope } from "./scope.ts";

export interface Ctx {
	readonly signal: AbortSignal;

	readonly restoreSignal: AbortSignal;

	readonly deferInterrupt?: boolean;

	readonly scope: Scope;

	readonly clock: Clock;
}

export { NEVER_ABORTED } from "./scheduler.ts";

export type SafeOp<S extends AnySafe = AnySafe> = (safe: S) => AnySafe;
type AnySafe = Safe<any, any>;

export class Safe<A, E> {
	readonly _tag = "Safe" as const;

	declare readonly _A: A;
	declare readonly _E: E;

	constructor(readonly body: (ctx: Ctx) => Outcome<A, E> | Promise<Outcome<A, E>>) {}

	sealed = false;

	[Symbol.iterator](): Iterator<Safe<A, E>, A, any> {
		return new SafeIterator(this);
	}

	[Symbol.asyncIterator](): AsyncIterator<Safe<A, E>, A, any> {
		return new SafeAsyncIterator(this);
	}

	static ok<A>(value: A): Safe<A, never> {
		return new PureSafe(value);
	}

	static err<E>(error: E): Safe<never, E> {
		return new Safe(() => Outcome.fail(error));
	}

	static call<A>(fn: (scheduler: Scheduler) => A | PromiseLike<A>): Safe<Awaited<A>, never>;
	static call<A, E>(
		fn: (scheduler: Scheduler) => A | PromiseLike<A>,
		mapErr: (thrown: unknown) => E,
	): Safe<Awaited<A>, E>;
	static call<A, E>(
		fn: (scheduler: Scheduler) => A | PromiseLike<A>,
		mapErr?: (thrown: unknown) => E,
	): Safe<Awaited<A>, E> {
		if (isGeneratorFunction(fn)) {
			return new Safe<Awaited<A>, E>(() =>
				Outcome.die(
					new TypeError(
						"safe-ts: Safe.call got a generator function; use Safe.try(...) to sequence",
					),
				),
			);
		}
		const call = new Safe<Awaited<A>, E>((ctx) => {
			const scheduler = new CallScheduler(ctx.signal, ctx.clock, ctx.deferInterrupt === true);
			let result: A | PromiseLike<A>;
			try {
				result = fn(scheduler);
			} catch (thrown) {
				return scheduler.finish(
					mapErr === undefined ? Outcome.die(thrown) : Outcome.fail(mapErr(thrown)),
				);
			}
			if (!isThenable(result)) return scheduler.finish(Outcome.succeed(result as Awaited<A>));

			return scheduler.settlePending(result as PromiseLike<Awaited<A>>, (s) =>
				fromSettled(s, mapErr),
			);
		});
		call.sealed = true;
		return call;
	}

	static try<Y extends Yieldable, T>(body: () => Generator<Y, T, any>): Safe<T, YieldError<Y>>;
	static try<Y extends Yieldable, T>(body: () => AsyncGenerator<Y, T, any>): Safe<T, YieldError<Y>>;
	static try(body: () => AnyGenerator): Safe<unknown, unknown> {
		const sequence = new Safe((ctx) => {
			const scope = new Scope();
			const exit = drive(body(), { ...ctx, scope });
			return isThenable(exit) ? exit.then((e) => scope.close(e)) : scope.close(exit);
		});

		sequence.sealed = true;
		return sequence;
	}

	static defer(
		release: (outcome: Outcome<unknown, unknown>) => void | PromiseLike<void>,
	): Safe<void, never>;
	static defer<A, E>(
		acquire: Safe<A, E>,
		release: (resource: A, outcome: Outcome<unknown, unknown>) => void | PromiseLike<void>,
	): Safe<A, E>;
	static defer<A, E>(
		first: ((outcome: Outcome<unknown, unknown>) => void | PromiseLike<void>) | Safe<A, E>,
		release?: (resource: A, outcome: Outcome<unknown, unknown>) => void | PromiseLike<void>,
	): Safe<A, E> | Safe<void, never> {
		if (first instanceof Safe) {
			const acquire = first;
			const rel = release as (
				resource: A,
				outcome: Outcome<unknown, unknown>,
			) => void | PromiseLike<void>;
			return new Safe<A, E>((ctx) => {
				const exit = exec(acquire, {
					...ctx,
					signal: NEVER_ABORTED,
					restoreSignal: ctx.signal,
				});
				const after = (out: Outcome<A, E>): Outcome<A, E> => {
					if (out._tag !== "success") return out;
					ctx.scope.add((scopeOutcome) => rel(out.value, scopeOutcome));
					return ctx.signal.aborted ? Outcome.interrupt() : out;
				};
				return isThenable(exit) ? exit.then(after) : after(exit);
			});
		}
		const cleanup = first;
		return new Safe<void, never>((ctx) => {
			ctx.scope.add(cleanup);
			return ctx.signal.aborted ? Outcome.interrupt() : Outcome.succeed(undefined);
		});
	}

	static pipe<A, E>(safe: Safe<A, E>): Safe<A, E>;
	static pipe<A, E, T1 extends AnySafe>(safe: Safe<A, E>, op1: (safe: Safe<A, E>) => T1): T1;
	static pipe<A, E, T1 extends AnySafe, T2 extends AnySafe>(
		safe: Safe<A, E>,
		op1: (safe: Safe<A, E>) => T1,
		op2: (safe: T1) => T2,
	): T2;
	static pipe<A, E, T1 extends AnySafe, T2 extends AnySafe, T3 extends AnySafe>(
		safe: Safe<A, E>,
		op1: (safe: Safe<A, E>) => T1,
		op2: (safe: T1) => T2,
		op3: (safe: T2) => T3,
	): T3;
	static pipe<A, E, T1 extends AnySafe, T2 extends AnySafe, T3 extends AnySafe, T4 extends AnySafe>(
		safe: Safe<A, E>,
		op1: (safe: Safe<A, E>) => T1,
		op2: (safe: T1) => T2,
		op3: (safe: T2) => T3,
		op4: (safe: T3) => T4,
	): T4;
	static pipe<
		A,
		E,
		T1 extends AnySafe,
		T2 extends AnySafe,
		T3 extends AnySafe,
		T4 extends AnySafe,
		T5 extends AnySafe,
	>(
		safe: Safe<A, E>,
		op1: (safe: Safe<A, E>) => T1,
		op2: (safe: T1) => T2,
		op3: (safe: T2) => T3,
		op4: (safe: T3) => T4,
		op5: (safe: T4) => T5,
	): T5;
	static pipe<
		A,
		E,
		T1 extends AnySafe,
		T2 extends AnySafe,
		T3 extends AnySafe,
		T4 extends AnySafe,
		T5 extends AnySafe,
		T6 extends AnySafe,
	>(
		safe: Safe<A, E>,
		op1: (safe: Safe<A, E>) => T1,
		op2: (safe: T1) => T2,
		op3: (safe: T2) => T3,
		op4: (safe: T3) => T4,
		op5: (safe: T4) => T5,
		op6: (safe: T5) => T6,
	): T6;
	static pipe<
		A,
		E,
		T1 extends AnySafe,
		T2 extends AnySafe,
		T3 extends AnySafe,
		T4 extends AnySafe,
		T5 extends AnySafe,
		T6 extends AnySafe,
		T7 extends AnySafe,
	>(
		safe: Safe<A, E>,
		op1: (safe: Safe<A, E>) => T1,
		op2: (safe: T1) => T2,
		op3: (safe: T2) => T3,
		op4: (safe: T3) => T4,
		op5: (safe: T4) => T5,
		op6: (safe: T5) => T6,
		op7: (safe: T6) => T7,
	): T7;
	static pipe<
		A,
		E,
		T1 extends AnySafe,
		T2 extends AnySafe,
		T3 extends AnySafe,
		T4 extends AnySafe,
		T5 extends AnySafe,
		T6 extends AnySafe,
		T7 extends AnySafe,
		T8 extends AnySafe,
	>(
		safe: Safe<A, E>,
		op1: (safe: Safe<A, E>) => T1,
		op2: (safe: T1) => T2,
		op3: (safe: T2) => T3,
		op4: (safe: T3) => T4,
		op5: (safe: T4) => T5,
		op6: (safe: T5) => T6,
		op7: (safe: T6) => T7,
		op8: (safe: T7) => T8,
	): T8;
	static pipe<A, E, T1 extends AnySafe>(
		safe: Safe<A, E>,
		ops: readonly [(safe: Safe<A, E>) => T1],
	): T1;
	static pipe(
		safe: AnySafe,
		first?: readonly ((s: AnySafe) => AnySafe)[] | ((s: AnySafe) => AnySafe),
		...rest: ((s: AnySafe) => AnySafe)[]
	): AnySafe {
		const ops = Array.isArray(first) ? first : first === undefined ? rest : [first, ...rest];
		return ops.reduce<AnySafe>((acc, op) => op(acc), safe);
	}

	pipe(): Safe<A, E>;
	pipe<T1 extends AnySafe>(op1: (safe: Safe<A, E>) => T1): T1;
	pipe<T1 extends AnySafe, T2 extends AnySafe>(
		op1: (safe: Safe<A, E>) => T1,
		op2: (safe: T1) => T2,
	): T2;
	pipe<T1 extends AnySafe, T2 extends AnySafe, T3 extends AnySafe>(
		op1: (safe: Safe<A, E>) => T1,
		op2: (safe: T1) => T2,
		op3: (safe: T2) => T3,
	): T3;
	pipe<T1 extends AnySafe, T2 extends AnySafe, T3 extends AnySafe, T4 extends AnySafe>(
		op1: (safe: Safe<A, E>) => T1,
		op2: (safe: T1) => T2,
		op3: (safe: T2) => T3,
		op4: (safe: T3) => T4,
	): T4;
	pipe<
		T1 extends AnySafe,
		T2 extends AnySafe,
		T3 extends AnySafe,
		T4 extends AnySafe,
		T5 extends AnySafe,
	>(
		op1: (safe: Safe<A, E>) => T1,
		op2: (safe: T1) => T2,
		op3: (safe: T2) => T3,
		op4: (safe: T3) => T4,
		op5: (safe: T4) => T5,
	): T5;
	pipe<
		T1 extends AnySafe,
		T2 extends AnySafe,
		T3 extends AnySafe,
		T4 extends AnySafe,
		T5 extends AnySafe,
		T6 extends AnySafe,
	>(
		op1: (safe: Safe<A, E>) => T1,
		op2: (safe: T1) => T2,
		op3: (safe: T2) => T3,
		op4: (safe: T3) => T4,
		op5: (safe: T4) => T5,
		op6: (safe: T5) => T6,
	): T6;
	pipe<
		T1 extends AnySafe,
		T2 extends AnySafe,
		T3 extends AnySafe,
		T4 extends AnySafe,
		T5 extends AnySafe,
		T6 extends AnySafe,
		T7 extends AnySafe,
	>(
		op1: (safe: Safe<A, E>) => T1,
		op2: (safe: T1) => T2,
		op3: (safe: T2) => T3,
		op4: (safe: T3) => T4,
		op5: (safe: T4) => T5,
		op6: (safe: T5) => T6,
		op7: (safe: T6) => T7,
	): T7;
	pipe<
		T1 extends AnySafe,
		T2 extends AnySafe,
		T3 extends AnySafe,
		T4 extends AnySafe,
		T5 extends AnySafe,
		T6 extends AnySafe,
		T7 extends AnySafe,
		T8 extends AnySafe,
	>(
		op1: (safe: Safe<A, E>) => T1,
		op2: (safe: T1) => T2,
		op3: (safe: T2) => T3,
		op4: (safe: T3) => T4,
		op5: (safe: T4) => T5,
		op6: (safe: T5) => T6,
		op7: (safe: T6) => T7,
		op8: (safe: T7) => T8,
	): T8;
	pipe(...ops: ((s: AnySafe) => AnySafe)[]): AnySafe {
		return ops.reduce<AnySafe>((acc, op) => op(acc), this);
	}

	static all<const T extends readonly Safe<any, any>[]>(safes: T): Safe<AllA<T>, AllE<T>> {
		return all(safes);
	}

	static allSettled<const T extends readonly Safe<any, any>[]>(
		safes: T,
	): Safe<AllSettledA<T>, never> {
		return allSettled(safes);
	}

	static race<const T extends readonly Safe<any, any>[]>(
		safes: T,
		options?: RaceOptions,
	): Safe<AllA<T>[number], AllE<T>> {
		return race(safes, options);
	}

	static delay(ms: number): Safe<void, never> {
		return delay(ms);
	}

	static forEach<A, B, E>(
		items: readonly A[],
		f: (item: A, index: number) => Safe<B, E>,
		options?: ForEachOptions,
	): Safe<readonly B[], E> {
		return forEach(items, f, options);
	}
}

export function catchTag<const K extends string, B, E2 = never>(
	code: K,
	f: (payload: any) => Safe<B, E2>,
) {
	return <A, E>(safe: Safe<A, E>): Safe<A | B, Exclude<E, Arm<E, K>> | E2> =>
		new Safe<A | B, Exclude<E, Arm<E, K>> | E2>((ctx) => {
			const recover = (exit: Outcome<A, E>) => {
				if (exit._tag === "fail" && hasTag(exit.error, code)) {
					return exec(f(payloadOf(exit.error, code)), ctx);
				}
				return exit as Outcome<A | B, Exclude<E, Arm<E, K>> | E2>;
			};
			const exit = exec(safe, ctx);
			return isThenable(exit)
				? exit.then(recover)
				: (recover(exit) as Outcome<A | B, Exclude<E, Arm<E, K>> | E2>);
		});
}

class PureSafe<A> extends Safe<A, never> {
	constructor(readonly value: A) {
		super(() => Outcome.succeed(value));
	}

	[Symbol.iterator](): Iterator<Safe<A, never>, A, any> {
		return new PureIterator(this.value);
	}

	[Symbol.asyncIterator](): AsyncIterator<Safe<A, never>, A, any> {
		return new PureAsyncIterator(this.value);
	}
}

class SafeAsyncIterator<A, E> implements AsyncIterator<Safe<A, E>, A, any> {
	#yielded = false;
	constructor(private readonly safe: Safe<A, E>) {}

	async next(input?: unknown): Promise<IteratorResult<Safe<A, E>, A>> {
		if (!this.#yielded) {
			this.#yielded = true;
			return { value: this.safe, done: false };
		}
		return { value: input as A, done: true };
	}

	async return(): Promise<IteratorResult<Safe<A, E>, A>> {
		return { value: undefined as A, done: true };
	}
}

class SafeIterator<A, E> implements Iterator<Safe<A, E>, A, any> {
	#yielded = false;
	constructor(private readonly safe: Safe<A, E>) {}

	next(input?: unknown): IteratorResult<Safe<A, E>, A> {
		if (!this.#yielded) {
			this.#yielded = true;
			return { value: this.safe, done: false };
		}
		return { value: input as A, done: true };
	}

	return(): IteratorResult<Safe<A, E>, A> {
		return { value: undefined as A, done: true };
	}
}

class PureAsyncIterator<A> implements AsyncIterator<Safe<A, never>, A, any> {
	constructor(private readonly value: A) {}

	async next(): Promise<IteratorResult<Safe<A, never>, A>> {
		return { value: this.value, done: true };
	}

	async return(): Promise<IteratorResult<Safe<A, never>, A>> {
		return { value: this.value, done: true };
	}
}

class PureIterator<A> implements Iterator<Safe<A, never>, A, any> {
	constructor(private readonly value: A) {}

	next(): IteratorResult<Safe<A, never>, A> {
		return { value: this.value, done: true };
	}

	return(): IteratorResult<Safe<A, never>, A> {
		return { value: this.value, done: true };
	}
}

const isGeneratorFunction = (fn: unknown): boolean => {
	const tag = Object.prototype.toString.call(fn);
	return tag === "[object GeneratorFunction]" || tag === "[object AsyncGeneratorFunction]";
};

export const hasTag = (e: unknown, code: string): boolean =>
	typeof e === "object" && e !== null && code in e;

export const payloadOf = (e: unknown, code: string): unknown =>
	typeof e === "object" && e !== null ? (e as Record<string, unknown>)[code] : undefined;

export const exec = <A, E>(safe: Safe<A, E>, ctx: Ctx): Outcome<A, E> | Promise<Outcome<A, E>> => {
	if (ctx.signal.aborted) return Outcome.interrupt();
	let out: Outcome<A, E> | Promise<Outcome<A, E>>;
	try {
		out = safe.body(ctx);
	} catch (defect) {
		return Outcome.die(defect);
	}

	if (!isThenable(out)) return out;
	return safe.sealed
		? out
		: out.then(
				(o) => o,
				(defect) => Outcome.die(defect),
			);
};

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

export interface RunOptions {
	readonly signal?: AbortSignal;

	readonly clock?: Clock;
}

export const run = async <A, E>(
	safe: Safe<A, E>,
	options: RunOptions = {},
): Promise<Outcome<A, E>> => {
	const root = new Scope();
	const signal = options.signal ?? NEVER_ABORTED;

	const exit = exec(safe, {
		signal,
		restoreSignal: signal,
		scope: root,
		clock: options.clock ?? Clocks.real,
	});
	return isThenable(exit) ? exit.then((o) => root.close(o)) : Promise.resolve(root.close(exit));
};

export type Yieldable = Safe<any, any>;

export type YieldError<Y> = Y extends Safe<any, infer E> ? E : never;

export type AnyGenerator =
	| Generator<unknown, unknown, unknown>
	| AsyncGenerator<unknown, unknown, unknown>;

export const drive = (
	it: AnyGenerator,
	ctx: Ctx,
): Outcome<unknown, unknown> | Promise<Outcome<unknown, unknown>> => {
	let input: unknown;
	for (;;) {
		if (ctx.signal.aborted) return close(it, Outcome.interrupt());

		const step = it.next(input);
		if (isThenable(step)) return driveFromStep(it, ctx, step);
		if (step.done) return Outcome.succeed(step.value);
		const resolved = resolveYield(step.value, ctx);
		if (isThenable(resolved)) return driveFromYield(it, ctx, resolved);
		if (resolved._tag !== "success") return close(it, resolved);
		input = resolved.value;
	}
};

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

		(defect) => Outcome.die(defect),
	);

const driveFromYield = (
	it: AnyGenerator,
	ctx: Ctx,
	pending: PromiseLike<Outcome<unknown, unknown>>,
): Promise<Outcome<unknown, unknown>> =>
	Promise.resolve(pending).then(
		(resolved) => driveResolved(it, ctx, resolved),
		(defect) => Outcome.die(defect),
	);

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

const closedOutcome = (
	outcome: Outcome<unknown, unknown>,
	defect: { readonly value: unknown } | undefined,
): Outcome<unknown, unknown> =>
	defect !== undefined && outcome._tag === "success" ? Outcome.die(defect.value) : outcome;

const resolveYield = (
	y: unknown,
	ctx: Ctx,
): Outcome<unknown, unknown> | Promise<Outcome<unknown, unknown>> => {
	if (y instanceof Safe) return exec(y, ctx);
	return Outcome.die(new TypeError("safe-ts: Safe.try yielded a value that is not yieldable"));
};
