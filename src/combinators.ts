// combinators.ts — the scheduling combinators that need no fiber loop.
//
// Effect gets timeout, retry and bounded fan-out from its runtime. None of the
// three needs one: each is `exec` plus a signal, a timer or a batch. fork/join
// is the one that does need a loop, and it stays out.
import { type AllA, type AllE, type AllR, all } from "./all.ts";
import { isThenable, Outcome } from "./outcome.ts";
import { type Ctx, exec, NEVER_ABORTED, Safe } from "./safe.ts";
import { Scope } from "./scope.ts";

type AnySafe = Safe<any, any, any>;

/** Wait `ms`, or reject with the signal's reason if it aborts first. */
const wait = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});

/** The reason a timeout aborts with, so it is not confused with a caller abort. */
export const TIMEOUT = Symbol("safe-ts.timeout");

/** Wait `ms`, or stop as an interrupt when the run is aborted first. */
export const sleep = (ms: number): Safe<void, never, never> =>
	new Safe<void, never, never>((ctx) => {
		if (ctx.signal.aborted) return Outcome.interrupt();
		if (ms <= 0) return Outcome.succeed(undefined);
		return wait(ms, ctx.signal).then(
			() => Outcome.succeed(undefined),
			() => Outcome.interrupt(),
		);
	});

/**
 * Run every Safe and keep the first to settle — success, failure or defect. The
 * losers are aborted through a local controller the way `Safe.all` aborts its
 * siblings, so a loser that ignores its signal still runs to completion.
 */
export const race = <const T extends readonly AnySafe[]>(
	safes: T,
): Safe<AllA<T>[number], AllE<T>, AllR<T>> =>
	new Safe<AllA<T>[number], AllE<T>, AllR<T>>((ctx) => {
		if (safes.length === 0) {
			return Outcome.die(new Error("safe-ts: Safe.race needs at least one Safe"));
		}
		const local = new AbortController();
		const child: Ctx = {
			...ctx,
			signal:
				ctx.signal === NEVER_ABORTED ? local.signal : AbortSignal.any([ctx.signal, local.signal]),
		};
		const pending: Promise<Outcome<unknown, unknown>>[] = [];
		for (const safe of safes) {
			const out = exec(safe as AnySafe, child);
			if (!isThenable(out)) {
				// A synchronous child settled on this tick: it won, nothing else starts.
				local.abort();
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
				resolve(outcome);
			};
			for (const one of pending) {
				one.then(
					(outcome) => win(outcome as Outcome<AllA<T>[number], AllE<T>>),
					(defect) => win(Outcome.die(defect)),
				);
			}
		});
	});

/**
 * Run `safe`, then always run `cleanup` with its outcome — on success, failure,
 * defect and interrupt. A throwing cleanup turns a success into a defect and
 * leaves any other outcome as it was, the same rule `Scope.close` applies.
 */
export const ensuring = <A, E, R>(
	safe: Safe<A, E, R>,
	cleanup: (exit: Outcome<A, E>) => void | PromiseLike<void>,
): Safe<A, E, R> =>
	new Safe<A, E, R>((ctx) => {
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

/**
 * Bound `safe` to `ms`. A timeout arrives as `interrupt` — the same arm a run
 * boundary abort produces — unless `onTimeout` is given, which turns it into a
 * typed failure instead.
 */
export const timeout = <A, E, R, E2 = never>(
	safe: Safe<A, E, R>,
	ms: number,
	onTimeout?: () => E2,
): Safe<A, E | E2, R> =>
	new Safe<A, E | E2, R>((ctx) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(TIMEOUT), ms);
		const child: Ctx = { ...ctx, signal: AbortSignal.any([ctx.signal, controller.signal]) };
		const finish = (out: Outcome<A, E | E2>): Outcome<A, E | E2> => {
			clearTimeout(timer);
			const timedOut = controller.signal.aborted && controller.signal.reason === TIMEOUT;
			return timedOut && out._tag === "interrupt" && onTimeout !== undefined
				? Outcome.fail(onTimeout())
				: out;
		};
		const exit = exec(safe, child);
		return isThenable(exit) ? exit.then(finish) : finish(exit);
	});

export interface RetryOptions {
	/** Total attempts, including the first. `1` means no retry. */
	readonly attempts: number;
	/** Fixed pause between attempts, in ms. Omit for an immediate retry. */
	readonly delayMs?: number;
}

/**
 * Run `safe` again when it fails, up to `attempts` times. Only a typed `fail`
 * is retried: a defect is a bug, and an interrupt means someone asked to stop.
 * Each attempt gets its own scope, so resources acquired by a failed attempt are
 * released before the next one starts.
 */
export const retry = <A, E, R>(safe: Safe<A, E, R>, options: RetryOptions): Safe<A, E, R> =>
	new Safe<A, E, R>((ctx) => {
		const attempts = Math.max(1, options.attempts);
		const delayMs = options.delayMs ?? 0;

		const afterFail = (
			outcome: Outcome<A, E>,
			attempt: number,
		): Outcome<A, E> | Promise<Outcome<A, E>> => {
			if (outcome._tag !== "fail" || attempt >= attempts) return outcome;
			if (delayMs <= 0) return once(attempt + 1);
			return wait(delayMs, ctx.signal).then(
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
	/** How many children may run at once. Defaults to all of them. */
	readonly concurrency?: number;
}

/**
 * Map over `items` and run the resulting Safes, keeping input order. With a
 * `concurrency` limit the work runs in sequential batches, each batch a
 * `Safe.all` — so a failure inside a batch still aborts that batch's siblings,
 * and no later batch starts.
 */
export const forEach = <A, B, E, R>(
	items: readonly A[],
	f: (item: A, index: number) => Safe<B, E, R>,
	options: ForEachOptions = {},
): Safe<readonly B[], E, R> =>
	new Safe<readonly B[], E, R>((ctx) => {
		const limit = Math.max(1, options.concurrency ?? (items.length || 1));
		const results: B[] = [];

		const from = (start: number): Outcome<readonly B[], E> | Promise<Outcome<readonly B[], E>> => {
			if (start >= items.length) return Outcome.succeed(results);
			const batch = all(
				items.slice(start, start + limit).map((item, k) => f(item, start + k)) as readonly Safe<
					B,
					E,
					R
				>[],
			);
			const exit = exec(batch as never, ctx) as
				| Outcome<readonly B[], E>
				| Promise<Outcome<readonly B[], E>>;
			const after = (
				outcome: Outcome<readonly B[], E>,
			): Outcome<readonly B[], E> | Promise<Outcome<readonly B[], E>> => {
				if (outcome._tag !== "success") return outcome;
				for (const value of outcome.value) results.push(value);
				return from(start + limit);
			};
			return isThenable(exit) ? exit.then(after) : after(exit);
		};

		return from(0);
	});
