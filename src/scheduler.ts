import { type Clock, Clocks } from "./clock.ts";
import { Outcome } from "./outcome.ts";

export const NEVER_ABORTED: AbortSignal = new AbortController().signal;

interface Cancelled {
	readonly failed: boolean;
	readonly defect?: unknown;
}

const NOOP = (): void => {};

export interface Scheduler {
	readonly signal: AbortSignal;

	onCancel(fn: () => void): () => void;

	now(): number;

	sleep(ms: number): Promise<void>;
}

export class CallScheduler implements Scheduler {
	#callbacks: (() => void)[] | undefined;
	#onAbort: ((cancelled: Cancelled) => void) | undefined;
	#listening = false;

	#bound: (() => void) | undefined;

	readonly #clock: Clock;
	readonly #deferInterrupt: boolean;

	constructor(
		readonly signal: AbortSignal,
		clock: Clock = Clocks.real,
		deferInterrupt = false,
	) {
		this.#clock = clock;
		this.#deferInterrupt = deferInterrupt;
	}

	#listen(): void {
		if (this.#listening || this.signal.aborted || this.signal === NEVER_ABORTED) return;
		this.#listening = true;
		this.#bound = this.#bound ?? this.#abort.bind(this);
		this.signal.addEventListener("abort", this.#bound, { once: true });
	}

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

	now(): number {
		return this.#clock.now();
	}

	sleep(ms: number): Promise<void> {
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

	finish<A, E>(outcome: Outcome<A, E>): Outcome<A, E> {
		this.#release();
		return outcome;
	}

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

	#settleWith<A, B>(map: (outcome: Outcome<A, unknown>) => B, outcome: Outcome<A, unknown>): B {
		this.#release();
		try {
			return map(outcome);
		} catch (defect) {
			return map(Outcome.die(defect));
		}
	}

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
				if (cancelled.failed) return finish(Outcome.die(cancelled.defect));

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

	#abort(): void {
		this.#listening = false;
		const cancelled = this.#cancel();
		this.#onAbort?.(cancelled);
	}

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
