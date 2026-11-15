// scheduler.ts — cancellation, owned by the library.
//
// `Safe.call` hands your callback a Scheduler instead of a raw AbortSignal.
// You register what should stop (`onCancel`) or you wait (`sleep`). The one
// `abort` listener is attached lazily — only when a callback is registered or an
// async body is in flight, i.e. when something can observe cancellation — and
// dropped when the call settles. Hand-wiring `signal.addEventListener` instead
// leaks a listener per call: `{ once: true }` only fires on abort, so a call
// that resolves normally never removes it (measured: 100 listeners / 100 runs).
import { type Clock, Clocks } from "./clock.ts";
import { Outcome } from "./outcome.ts";

/**
 * The signal a run gets when nobody passed one: nothing can ever abort it, so a
 * Scheduler on it never attaches an abort listener (which costs 248 ns).
 */
export const NEVER_ABORTED: AbortSignal = new AbortController().signal;

/** What running the registered callbacks found. Internal. */
interface Cancelled {
	readonly failed: boolean;
	readonly defect?: unknown;
}

const NOOP = (): void => {};

export class Scheduler {
	/** Created on first registration: a call that registers nothing allocates nothing. */
	#callbacks: (() => void)[] | undefined;
	#onAbort: ((cancelled: Cancelled) => void) | undefined;
	#listening = false;
	/** Bound lazily: only a call that actually listens needs a closure. */
	#bound: (() => void) | undefined;

	readonly #clock: Clock;
	readonly #deferInterrupt: boolean;

	/** `signal` is the run's own signal: pass it to APIs that take one. */
	constructor(
		readonly signal: AbortSignal,
		clock: Clock = Clocks.real,
		deferInterrupt = false,
	) {
		this.#clock = clock;
		this.#deferInterrupt = deferInterrupt;
	}

	get aborted(): boolean {
		return this.signal.aborted;
	}

	/** Attach the listener on first use: a call that never registers never pays. */
	#listen(): void {
		if (this.#listening || this.signal.aborted || this.signal === NEVER_ABORTED) return;
		this.#listening = true;
		this.#bound = this.#bound ?? this.#abort.bind(this);
		this.signal.addEventListener("abort", this.#bound, { once: true });
	}

	/**
	 * Run `fn` when the run is cancelled — immediately if it already is. The
	 * returned function unregisters it; everything is cleared when the call
	 * settles.
	 */
	onCancel(fn: () => void): () => void {
		if (this.signal.aborted) {
			fn();
			return NOOP;
		}
		this.#listen();
		this.#callbacks = this.#callbacks ?? [];
		this.#callbacks.push(fn);
		return () => {
			const at = this.#callbacks?.indexOf(fn) ?? -1;
			if (at >= 0) this.#callbacks?.splice(at, 1);
		};
	}

	/** The run's clock: same `now` every timer in the run reads. */
	now(): number {
		return this.#clock.now();
	}

	/** Resolve after `ms`, or reject with the signal's reason when cancelled. */
	sleep(ms: number): Promise<void> {
		// Off the real clock a manual one virtualises the wait entirely.
		if (this.#clock !== Clocks.real) return this.#clock.sleep(ms, this.signal);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				dispose();
				resolve();
			}, ms);
			const dispose = this.onCancel(() => {
				clearTimeout(timer);
				reject(this.signal.reason);
			});
		});
	}

	/**
	 * Run `start` and settle it against cancellation, whichever comes first.
	 * Never rejects: a throw from `start` arrives as an unclassified `fail`,
	 * a rejection after the abort counts as the interrupt, and a throwing
	 * `onCancel` callback makes the settle a `die`. `Safe.call` decides whether
	 * that unclassified failure was declared or a defect.
	 *
	 * A body that returns a plain value settles synchronously — no promise, no
	 * listener — because a value that already finished cannot be interrupted.
	 *
	 * @internal Use `Safe.call`.
	 */
	/**
	 * Finish a call whose body returned synchronously: drop the listener and the
	 * registered callbacks, and pass the outcome through. This is the sync half of
	 * settling without a thunk closure or a tag switch (measured 17 ns a call).
	 */
	finish<A, E>(outcome: Outcome<A, E>): Outcome<A, E> {
		this.#release();
		return outcome;
	}

	/**
	 * The async half: settle a promise the body returned. Never rejects.
	 *
	 * On a signal nothing can abort there is no listener to race, so the call
	 * settles on `pending` alone — one promise instead of the two `#settleAsync`
	 * needs to let the listener resolve it (measured 69 ns a hop).
	 */
	settlePending<A, B>(
		pending: PromiseLike<A>,
		map: (outcome: Outcome<A, unknown>) => B,
	): Promise<B> {
		if (this.signal !== NEVER_ABORTED) return this.#settleAsync(pending, map);
		return Promise.resolve(pending).then(
			(value) => this.#settleWith(map, Outcome.succeed(value)),
			(error) => this.#settleWith(map, Outcome.fail(error)),
		);
	}

	/** Release, then map — a throw in the mapper is a defect, never a rejection. */
	#settleWith<A, B>(map: (outcome: Outcome<A, unknown>) => B, outcome: Outcome<A, unknown>): B {
		this.#release();
		try {
			return map(outcome);
		} catch (defect) {
			return map(Outcome.die(defect));
		}
	}

	/** The async branch: the only place a listener is needed while work runs. */
	#settleAsync<A, B>(
		pending: PromiseLike<A>,
		map: (outcome: Outcome<A, unknown>) => B,
	): Promise<B> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (outcome: Outcome<A, unknown>) => {
				if (settled) return;
				settled = true;
				resolve(this.#settleWith(map, outcome));
			};
			this.#onAbort = (cancelled) => {
				// A throwing cancel callback is a defect now, never deferred.
				if (cancelled.failed) return finish(Outcome.die(cancelled.defect));
				// Deferred: the interrupt lands when the body settles, so a loser
				// racing with awaitLosers is awaited for real.
				if (!this.#deferInterrupt) finish(Outcome.interrupt());
			};
			this.#listen();
			pending.then(
				(value) =>
					finish(
						this.signal.aborted && this.#deferInterrupt
							? Outcome.interrupt()
							: Outcome.succeed(value),
					),
				(error) => finish(this.signal.aborted ? Outcome.interrupt() : Outcome.fail(error)),
			);
		});
	}

	/**
	 * The one abort listener: run the callbacks, then report to the settle. A
	 * prototype method, not an instance arrow property — an arrow property
	 * allocates a closure per Scheduler (measured 34 ns) for a listener that
	 * most calls never attach.
	 */
	#abort(): void {
		this.#listening = false;
		const cancelled = this.#cancel();
		this.#onAbort?.(cancelled);
	}

	/** Run every registered callback; the first throw wins. */
	#cancel(): Cancelled {
		const pending = this.#callbacks?.splice(0) ?? [];
		let failed = false;
		let defect: unknown;
		for (const fn of pending) {
			try {
				fn();
			} catch (thrown) {
				if (!failed) {
					failed = true;
					defect = thrown;
				}
			}
		}
		return { failed, defect };
	}

	#release(): void {
		if (this.#listening && this.#bound !== undefined) {
			this.signal.removeEventListener("abort", this.#bound);
			this.#listening = false;
		}
		this.#callbacks = undefined;
		this.#onAbort = undefined;
	}
}
