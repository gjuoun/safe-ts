import { type AllA, type AllE, all } from "./all.ts";
import { isThenable, Outcome } from "./outcome.ts";
import { Policy } from "./policy.ts";
import { type Ctx, exec, NEVER_ABORTED, Safe } from "./safe.ts";
import { Scope } from "./scope.ts";

type AnySafe = Safe<any, any>;

export const TIMEOUT = Symbol("safe-ts.timeout");

export const delay = (ms: number): Safe<void, never> =>
	new Safe<void, never>((ctx) => {
		if (ctx.signal.aborted) return Outcome.interrupt();
		if (ms <= 0) return Outcome.succeed(undefined);
		return ctx.clock.sleep(ms, ctx.signal).then(
			() => Outcome.succeed(undefined),
			() => Outcome.interrupt(),
		);
	});

export interface RaceOptions {
	readonly awaitLosers?: boolean;
}

export const race = <const T extends readonly AnySafe[]>(
	safes: T,
	options: RaceOptions = {},
): Safe<AllA<T>[number], AllE<T>> =>
	new Safe<AllA<T>[number], AllE<T>>((ctx) => {
		if (safes.length === 0) {
			return Outcome.die(new Error("safe-ts: Safe.race needs at least one Safe"));
		}
		const local = new AbortController();
		const child: Ctx = {
			...ctx,
			signal:
				ctx.signal === NEVER_ABORTED ? local.signal : AbortSignal.any([ctx.signal, local.signal]),

			deferInterrupt: options.awaitLosers === true,
		};
		const pending: Promise<Outcome<unknown, unknown>>[] = [];
		for (const safe of safes) {
			const out = exec(safe as AnySafe, child);
			if (!isThenable(out)) {
				local.abort();
				if (options.awaitLosers === true && pending.length > 0) {
					return Promise.all(pending).then(() => out as Outcome<AllA<T>[number], AllE<T>>);
				}
				return out as Outcome<AllA<T>[number], AllE<T>>;
			}
			pending.push(out);
		}
		return new Promise<Outcome<AllA<T>[number], AllE<T>>>((resolve) => {
			let settled = false;
			const win = (outcome: Outcome<AllA<T>[number], AllE<T>>) => {
				if (settled) return;
				settled = true;
				local.abort();
				if (options.awaitLosers === true) {
					Promise.all(pending).then(() => resolve(outcome));
				} else {
					resolve(outcome);
				}
			};
			for (const one of pending) {
				one.then(
					(outcome) => win(outcome as Outcome<AllA<T>[number], AllE<T>>),
					(defect) => win(Outcome.die(defect)),
				);
			}
		});
	});

const defer =
	(cleanup: (exit: Outcome<unknown, unknown>) => void | PromiseLike<void>) =>
	<A, E>(safe: Safe<A, E>): Safe<A, E> =>
		new Safe<A, E>((ctx) => {
			const settled = (outcome: Outcome<A, E>, defect?: { readonly value: unknown }) =>
				defect !== undefined && outcome._tag === "success" ? Outcome.die(defect.value) : outcome;
			const runCleanup = (outcome: Outcome<A, E>): Outcome<A, E> | Promise<Outcome<A, E>> => {
				let done: void | PromiseLike<void>;
				try {
					done = cleanup(outcome);
				} catch (defect) {
					return settled(outcome, { value: defect });
				}
				return isThenable(done)
					? Promise.resolve(done).then(
							() => settled(outcome),
							(defect) => settled(outcome, { value: defect }),
						)
					: settled(outcome);
			};
			const exit = exec(safe, ctx);
			return isThenable(exit) ? exit.then(runCleanup) : runCleanup(exit);
		});

function timeout(ms: number): <A, E>(safe: Safe<A, E>) => Safe<A, E>;
function timeout<E2>(ms: number, onTimeout: () => E2): <A, E>(safe: Safe<A, E>) => Safe<A, E | E2>;
function timeout(ms: number, onTimeout?: () => unknown) {
	return <A, E>(safe: Safe<A, E>): Safe<A, E> =>
		new Safe<A, E>((ctx) => {
			const controller = new AbortController();
			const ticking = ctx.clock.sleep(ms, controller.signal).then(
				() => controller.abort(TIMEOUT),
				() => {},
			);
			const child: Ctx = {
				...ctx,
				signal: AbortSignal.any([ctx.signal, controller.signal]),
			};
			const finish = (out: Outcome<A, E>): Outcome<A, E> => {
				if (!controller.signal.aborted) controller.abort();
				const timedOut = controller.signal.aborted && controller.signal.reason === TIMEOUT;
				return timedOut && out._tag === "interrupt" && onTimeout !== undefined
					? (Outcome.fail(onTimeout()) as Outcome<A, E>)
					: out;
			};
			void ticking;
			const exit = exec(safe, child);
			return isThenable(exit) ? exit.then(finish) : finish(exit);
		}) as Safe<A, E>;
}

export interface RetryOptions {
	readonly attempts: number;

	readonly delayMs?: number;
}

const retry =
	<Err = any>(options: RetryOptions | Policy<Err>) =>
	<A, E>(safe: Safe<A, E>): Safe<A, E> =>
		new Safe<A, E>((ctx) => {
			const policy: Policy<any> =
				typeof options === "function"
					? (options as Policy<any>)
					: Policy.pipe(Policy.spaced(options.delayMs ?? 0), [
							Policy.while((s) => s.attempt < Math.max(1, options.attempts)),
						]);
			const started = ctx.clock.now();

			const afterFail = (
				outcome: Outcome<A, E>,
				attempt: number,
			): Outcome<A, E> | Promise<Outcome<A, E>> => {
				if (outcome._tag !== "fail") return outcome;
				const ms = policy({
					attempt,
					error: outcome.error,
					elapsed: ctx.clock.now() - started,
				});
				if (ms === undefined) return outcome;
				if (ms <= 0) return once(attempt + 1);
				return ctx.clock.sleep(ms, ctx.signal).then(
					() => once(attempt + 1),
					() => Outcome.interrupt(),
				);
			};

			const once = (attempt: number): Outcome<A, E> | Promise<Outcome<A, E>> => {
				const scope = new Scope();
				const exit = exec(safe, { ...ctx, scope });
				const after = (outcome: Outcome<A, E>): Outcome<A, E> | Promise<Outcome<A, E>> => {
					const closed = scope.close(outcome);
					return isThenable(closed)
						? closed.then((settled) => afterFail(settled as Outcome<A, E>, attempt))
						: afterFail(closed as Outcome<A, E>, attempt);
				};
				return isThenable(exit) ? exit.then(after) : after(exit);
			};

			return once(1);
		});

export interface ForEachOptions {
	readonly concurrency?: number;
}

export const forEach = <A, B, E>(
	items: readonly A[],
	f: (item: A, index: number) => Safe<B, E>,
	options: ForEachOptions = {},
): Safe<readonly B[], E> =>
	new Safe<readonly B[], E>((ctx) => {
		const limit = Math.max(1, options.concurrency ?? items.length);
		if (limit >= items.length) {
			const joined = all(items.map((item, i) => f(item, i)) as readonly Safe<B, E>[]) as Safe<
				readonly B[],
				E
			>;
			return exec(joined, ctx);
		}
		const local = new AbortController();
		const child: Ctx = {
			...ctx,
			signal:
				ctx.signal === NEVER_ABORTED ? local.signal : AbortSignal.any([ctx.signal, local.signal]),
		};
		const results: B[] = new Array(items.length);
		let next = 0;
		let first: Outcome<never, E> | undefined;
		const stop = (outcome: Outcome<unknown, E>) => {
			if (first === undefined) {
				first = outcome as Outcome<never, E>;
				local.abort();
			}
		};

		const lane = async (): Promise<void> => {
			while (first === undefined) {
				const i = next;
				next += 1;
				if (i >= items.length) return;
				let exit: Outcome<B, E> | Promise<Outcome<B, E>>;
				try {
					exit = exec(f(items[i] as A, i), child);
				} catch (defect) {
					stop(Outcome.die(defect));
					return;
				}
				const outcome = isThenable(exit) ? await exit : exit;
				if (outcome._tag !== "success") {
					stop(outcome);
					return;
				}
				results[i] = outcome.value;
			}
		};
		const lanes: Promise<void>[] = [];
		for (let k = 0; k < limit; k++) lanes.push(lane());
		return Promise.all(lanes).then(() => first ?? Outcome.succeed(results));
	});

const scoped = <A, E>(safe: Safe<A, E>): Safe<A, E> =>
	new Safe<A, E>((ctx) => {
		const scope = new Scope();
		const exit = exec(safe, { ...ctx, scope });
		return isThenable(exit) ? exit.then((e) => scope.close(e)) : scope.close(exit);
	});

const uninterruptible = <A, E>(safe: Safe<A, E>): Safe<A, E> =>
	new Safe<A, E>((ctx) => {
		const exit = exec(safe, { ...ctx, signal: NEVER_ABORTED, restoreSignal: ctx.signal });
		const recheck = (out: Outcome<A, E>): Outcome<A, E> =>
			out._tag === "die" ? out : ctx.signal.aborted ? Outcome.interrupt() : out;
		return isThenable(exit) ? exit.then(recheck) : recheck(exit);
	});

const interruptible = <A, E>(safe: Safe<A, E>): Safe<A, E> =>
	new Safe<A, E>((ctx) => {
		if (ctx.signal !== NEVER_ABORTED) return exec(safe, ctx);
		return exec(safe, { ...ctx, signal: ctx.restoreSignal });
	});

export const ops = {
	timeout,
	retry,
	defer,
	scoped,
	uninterruptible,
	interruptible,
} as const;
