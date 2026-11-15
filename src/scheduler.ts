// scheduler.ts — cancellation, owned by the library.
//
// `Safe.call` hands your callback a Scheduler instead of a raw AbortSignal.
// You register what should stop (`onCancel`) or you wait (`sleep`). The one
// `abort` listener is attached lazily — only when a callback is registered or an
// async body is in flight, i.e. when something can observe cancellation — and
// dropped when the call settles. Hand-wiring `signal.addEventListener` instead
// leaks a listener per call: `{ once: true }` only fires on abort, so a call
// that resolves normally never removes it (measured: 100 listeners / 100 runs).
import { isThenable, Outcome } from "./outcome.ts";

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

	/** `signal` is the run's own signal: pass it to APIs that take one. */
	constructor(readonly signal: AbortSignal) {}

	get aborted(): boolean {
		return this.signal.aborted;
	}

	/** Attach the listener on first use: a call that never registers never pays. */
	#listen(): void {
		if (this.#listening || this.signal.aborted) return;
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

	/** Resolve after `ms`, or reject with the signal's reason when cancelled. */
	sleep(ms: number): Promise<void> {
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
	settle<A>(
		start: () => A | PromiseLike<A>,
	): Outcome<Awaited<A>, unknown> | Promise<Outcome<Awaited<A>, unknown>> {
		if (this.signal.aborted) return Outcome.interrupt();
		let result: A | PromiseLike<A>;
		try {
			result = start();
		} catch (error) {
			this.#release();
			return Outcome.fail(error);
		}
		if (!isThenable(result)) {
			this.#release();
			return Outcome.succeed(result as Awaited<A>);
		}
		return this.#settleAsync(result as PromiseLike<Awaited<A>>);
	}

	/** The async branch: the only place a listener is needed while work runs. */
	#settleAsync<A>(pending: PromiseLike<A>): Promise<Outcome<A, unknown>> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (outcome: Outcome<A, unknown>) => {
				if (settled) return;
				settled = true;
				this.#release();
				resolve(outcome);
			};
			this.#onAbort = (cancelled) =>
				finish(cancelled.failed ? Outcome.die(cancelled.defect) : Outcome.interrupt());
			this.#listen();
			pending.then(
				(value) => finish(Outcome.succeed(value)),
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
