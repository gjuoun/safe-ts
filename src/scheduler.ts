// scheduler.ts — cancellation, owned by the library.
//
// `Safe.call` hands your callback a Scheduler instead of a raw AbortSignal.
// You register what should stop (`onCancel`) or you wait (`sleep`); the class
// attaches the one `abort` listener when it is built and drops it when the call
// settles. Hand-wiring `signal.addEventListener` instead leaks a listener per
// call — `{ once: true }` only fires on abort, so a call that resolves normally
// never removes it (measured: 100 listeners over 100 runs).
import type { Outcome } from "./outcome.ts";

/** What running the registered callbacks found. Internal. */
interface Cancelled {
	readonly failed: boolean;
	readonly defect?: unknown;
}

export class Scheduler {
	readonly #callbacks: (() => void)[] = [];
	#onAbort: ((cancelled: Cancelled) => void) | undefined;
	#listening: boolean;

	/** `signal` is the run's own signal: pass it to APIs that take one. */
	constructor(readonly signal: AbortSignal) {
		this.#listening = !signal.aborted;
		if (this.#listening) signal.addEventListener("abort", this.#abort, { once: true });
	}

	get aborted(): boolean {
		return this.signal.aborted;
	}

	/**
	 * Run `fn` when the run is cancelled — immediately if it already is. The
	 * returned function unregisters it; everything is cleared when the call
	 * settles.
	 */
	onCancel(fn: () => void): () => void {
		if (this.signal.aborted) {
			fn();
			return () => {};
		}
		this.#callbacks.push(fn);
		return () => {
			const at = this.#callbacks.indexOf(fn);
			if (at >= 0) this.#callbacks.splice(at, 1);
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
	 * @internal Use `Safe.call`.
	 */
	settle<A>(start: () => A | PromiseLike<A>): Promise<Outcome<Awaited<A>, unknown>> {
		return new Promise((resolve) => {
			if (this.signal.aborted) return resolve({ _tag: "interrupt" });
			let settled = false;
			const finish = (s: Outcome<Awaited<A>, unknown>) => {
				if (settled) return;
				settled = true;
				this.#release();
				resolve(s);
			};
			this.#onAbort = (cancelled) =>
				finish(
					cancelled.failed ? { _tag: "die", defect: cancelled.defect } : { _tag: "interrupt" },
				);
			// `start` may return a plain value or a promise; both resolve here.
			(Promise.resolve().then(start) as Promise<Awaited<A>>).then(
				(value) => finish({ _tag: "success", value }),
				(error) => finish(this.signal.aborted ? { _tag: "interrupt" } : { _tag: "fail", error }),
			);
		});
	}

	/** The one abort listener: run the callbacks, then report to the settle. */
	readonly #abort = () => {
		this.#listening = false;
		const cancelled = this.#cancel();
		this.#onAbort?.(cancelled);
	};

	/** Run every registered callback; the first throw wins. */
	#cancel(): Cancelled {
		const pending = this.#callbacks.splice(0);
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
		if (this.#listening) {
			this.signal.removeEventListener("abort", this.#abort);
			this.#listening = false;
		}
		this.#callbacks.length = 0;
		this.#onAbort = undefined;
	}
}
