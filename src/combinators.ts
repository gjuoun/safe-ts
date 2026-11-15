// combinators.ts — the scheduling combinators, as `Safe → Safe` factories.
//
// One entry: `Safe.pipe(safe, timeout(2_000), retry(policy))` folds these
// factories left to right. None of them needs a fiber loop: each is `exec`
// plus a signal, a timer or a lane. fork/join is the one that does need a
// loop, and it stays out.
import { type AllA, type AllE, type AllR, all } from "./all.ts";
import { isThenable, Outcome } from "./outcome.ts";
import { Policy } from "./policy.ts";
import { type Ctx, exec, NEVER_ABORTED, Safe } from "./safe.ts";
import { Scope } from "./scope.ts";

type AnySafe = Safe<any, any, any>;

/** The reason a timeout aborts with, so it is not confused with a caller abort. */
export const TIMEOUT = Symbol("safe-ts.timeout");

/** Wait `ms` on the run's clock; an abort during the wait is an interrupt. */
export const delay = (ms: number): Safe<void, never, never> =>
	new Safe<void, never, never>((ctx) => {
		if (ctx.signal.aborted) return Outcome.interrupt();
		if (ms <= 0) return Outcome.succeed(undefined);
		return ctx.clock.sleep(ms, ctx.signal).then(
			() => Outcome.succeed(undefined),
			() => Outcome.interrupt(),
		);
	});

export interface RaceOptions {
	/** Await every loser after the winner settles, so "returned" means "stopped". */
	readonly awaitLosers?: boolean;
}

/**
 * Run every Safe and keep the first to settle — success, failure or defect. The
 * losers are aborted through a local controller the way `Safe.all` aborts its
 * siblings, so a loser that ignores its signal still runs to completion unless
 * `awaitLosers` asks the winner to wait for it.
 */
export const race = <const T extends readonly AnySafe[]>(
	safes: T,
	options: RaceOptions = {},
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
			// awaitLosers: a loser's interrupt lands when its body settles, so
			// `pending` resolves at the work's real end, not at the abort.
			deferInterrupt: options.awaitLosers === true,
		};
		const pending: Promise<Outcome<unknown, unknown>>[] = [];
		for (const safe of safes) {
			const out = exec(safe as AnySafe, child);
			if (!isThenable(out)) {
				// A synchronous child settled on this tick: it won, nothing else starts.
				local.abort();
				if (options.awaitLosers === true && pending.length > 0) {
					// The losers still in flight are awaited to their real end.
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
					// exec's promises never reject: every loser lands as an Outcome.
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

/**
 * Run `safe`, then always run `cleanup` with its outcome — on success, failure,
 * defect and interrupt. A throwing cleanup turns a success into a defect and
 * leaves any other outcome as it was, the same rule `Scope.close` applies.
 */
const ensuring =
	(cleanup: (exit: Outcome<unknown, unknown>) => void | PromiseLike<void>) =>
	<A, E, R>(safe: Safe<A, E, R>): Safe<A, E, R> =>
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
 * typed failure instead. The deadline waits on the run's clock, so
 * `Clocks.manual()` virtualises it.
 */
function timeout(ms: number): <A, E, R>(safe: Safe<A, E, R>) => Safe<A, E, R>;
function timeout<E2>(
	ms: number,
	onTimeout: () => E2,
): <A, E, R>(safe: Safe<A, E, R>) => Safe<A, E | E2, R>;
function timeout(ms: number, onTimeout?: () => unknown) {
	// The generics live on the returned arrow — `timeout(10)` is still a
	// generic `Safe → Safe`, so `pipe` can instantiate it per call site.
	return <A, E, R>(safe: Safe<A, E, R>): Safe<A, E, R> =>
		new Safe<A, E, R>((ctx) => {
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
		}) as Safe<A, E, R>;
}

export interface RetryOptions {
	/** Total attempts, including the first. `1` means no retry. */
	readonly attempts: number;
	/** Fixed pause between attempts, in ms. Omit for an immediate retry. */
	readonly delayMs?: number;
}

/**
 * Run `safe` again when it fails, deciding per attempt with a `Policy` — a
 * `(state) => ms | undefined` value assembled from `Policy.*` — or the
 * `{ attempts, delayMs }` sugar, which is `Policy.pipe(Policy.spaced(delayMs),
 * Policy.while(s => s.attempt < attempts))`. Only a typed `fail` is retried: a
 * defect is a bug, and an interrupt means someone asked to stop. Each attempt
 * gets its own scope, so resources acquired by a failed attempt are released
 * before the next one starts. The wait runs on the run's clock.
 */
const retry =
	<Err = any>(options: RetryOptions | Policy<Err>) =>
	<A, E, R>(safe: Safe<A, E, R>): Safe<A, E, R> =>
		new Safe<A, E, R>((ctx) => {
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
	/** How many children may run at once. Defaults to all of them. */
	readonly concurrency?: number;
}

/**
 * Map over `items` and run the resulting Safes, keeping input order. At
 * `concurrency: n` a sliding window keeps n lanes in flight — a lane starts
 * the next item as soon as it finishes, so a slow item no longer blocks the
 * batch behind it. The first non-success outcome aborts the siblings and
 * becomes the result; with no limit it is `Safe.all`, which also holds the
 * synchronous fast path.
 */
export const forEach = <A, B, E, R>(
	items: readonly A[],
	f: (item: A, index: number) => Safe<B, E, R>,
	options: ForEachOptions = {},
): Safe<readonly B[], E, R> =>
	new Safe<readonly B[], E, R>((ctx) => {
		const limit = Math.max(1, options.concurrency ?? items.length);
		if (limit >= items.length) {
			const joined = all(items.map((item, i) => f(item, i)) as readonly Safe<B, E, R>[]) as Safe<
				readonly B[],
				E,
				R
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
		// One lane pulls items until the cursor is spent or a sibling stopped. A
		// lane never rejects: `exec` settles every exit as an Outcome.
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

/** Run `safe` in a fresh scope; its finalizers run (LIFO) as soon as it exits. */
const scoped = <A, E, R>(safe: Safe<A, E, R>): Safe<A, E, R> =>
	new Safe<A, E, R>((ctx) => {
		const scope = new Scope();
		const exit = exec(safe, { ...ctx, scope });
		return isThenable(exit) ? exit.then((e) => scope.close(e)) : scope.close(exit);
	});

/**
 * Acquire a resource and register its release on the current scope. The
 * acquire step is not interruptible, so an acquired resource is always
 * released. `release` gets the scope's outcome.
 */
const acquireRelease =
	(release: (resource: any, exit: Outcome<unknown, unknown>) => void | PromiseLike<void>) =>
	<A, E, R>(acquire: Safe<A, E, R>): Safe<A, E, R> =>
		new Safe<A, E, R>((ctx) => {
			const exit = exec(acquire, {
				...ctx,
				signal: NEVER_ABORTED,
				restoreSignal: ctx.signal,
			});
			return isThenable(exit)
				? exit.then((e) => afterAcquire(e, ctx, release))
				: afterAcquire(exit, ctx, release);
		});

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

/**
 * Run `safe` where no abort lands: the run's signal is masked for the whole
 * region, so a deadline cannot cut it. When the region exits, an abort that
 * was deferred is observed — the outcome becomes `interrupt` — and a defect
 * stays a defect.
 */
const uninterruptible = <A, E, R>(safe: Safe<A, E, R>): Safe<A, E, R> =>
	new Safe<A, E, R>((ctx) => {
		const exit = exec(safe, { ...ctx, signal: NEVER_ABORTED, restoreSignal: ctx.signal });
		const recheck = (out: Outcome<A, E>): Outcome<A, E> =>
			out._tag === "die" ? out : ctx.signal.aborted ? Outcome.interrupt() : out;
		return isThenable(exit) ? exit.then(recheck) : recheck(exit);
	});

/**
 * Undo a surrounding `uninterruptible` mask for this region. Outside a mask it
 * changes nothing: a signal that is not `NEVER_ABORTED` is restored to itself.
 */
const interruptible = <A, E, R>(safe: Safe<A, E, R>): Safe<A, E, R> =>
	new Safe<A, E, R>((ctx) => {
		if (ctx.signal !== NEVER_ABORTED) return exec(safe, ctx);
		return exec(safe, { ...ctx, signal: ctx.restoreSignal });
	});

/**
 * The pipe ops: every `Safe → Safe` the library ships, in one namespace. They
 * assemble inside `Safe.pipe` / `.pipe` — `Pipe.timeout`, `Pipe.retry`,
 * `Pipe.ensuring`, `Pipe.scoped`, `Pipe.acquireRelease`, `Pipe.uninterruptible`,
 * `Pipe.interruptible` — and `Pipe.provide` for the services side.
 */
export const ops = {
	timeout,
	retry,
	ensuring,
	scoped,
	acquireRelease,
	uninterruptible,
	interruptible,
} as const;
