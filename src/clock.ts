// clock.ts — where the time comes from.
//
// `Clock` is two functions: `now` and `sleep`. Every timer in the library —
// `Safe.delay`, `Scheduler.sleep`, `timeout`'s deadline, `retry`'s wait — goes
// through the run's `Clock`, so `Clocks.manual()` virtualises all of them for
// tests. `clock.sleep` rejects with the signal's reason when it aborts, exactly
// like the old `wait`, so an abort during a wait is an interrupt upstream.
/** Time source: read `now` and sleep for `ms` unless the signal aborts. */
export interface Clock {
	/** Milliseconds since this clock's epoch. */
	now(): number;
	/** Resolve after `ms`; reject with `signal.reason` if the signal aborts first. */
	sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** A wait queue entry for the manual clock. */
interface Waiter {
	readonly at: number;
	readonly drop: () => void;
	readonly resolve: () => void;
}

/**
 * The two clocks. `Clocks.real` is the platform's `Date.now` + `setTimeout`;
 * `Clocks.manual()` returns `{ clock, advance, now }` whose `advance` fires
 * every wait scheduled at or before the new time, in order — sleeps then
 * resolve on the microtask queue, so a test awaits a tick to see them.
 */
export const Clocks = {
	real: {
		now: () => Date.now(),
		sleep: (ms: number, signal: AbortSignal): Promise<void> =>
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
			}),
	} satisfies Clock,

	manual(): { clock: Clock; advance: (ms: number) => void; now: () => number } {
		let now = 0;
		const waiters: Waiter[] = [];

		const clock: Clock = {
			now: () => now,
			sleep: (ms: number, signal: AbortSignal): Promise<void> =>
				new Promise((resolve, reject) => {
					if (signal.aborted) {
						reject(signal.reason);
						return;
					}
					const waiter: Waiter = {
						at: now + ms,
						drop: () => {
							signal.removeEventListener("abort", onAbort);
							const i = waiters.indexOf(waiter);
							if (i >= 0) waiters.splice(i, 1);
						},
						resolve,
					};
					const onAbort = () => {
						waiter.drop();
						reject(signal.reason);
					};
					waiters.push(waiter);
					signal.addEventListener("abort", onAbort, { once: true });
				}),
		};

		const advance = (ms: number): void => {
			const until = now + ms;
			for (;;) {
				const i = waiters.findIndex((w) => w.at <= until);
				if (i < 0) break;
				const w = waiters[i] as Waiter;
				waiters.splice(i, 1);
				now = Math.max(now, w.at);
				w.drop();
				w.resolve();
			}
			now = until;
		};

		return { clock, advance, now: () => now };
	},
};
