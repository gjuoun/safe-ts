export interface Clock {
	now(): number;

	sleep(ms: number, signal: AbortSignal): Promise<void>;
}

interface Waiter {
	readonly at: number;
	readonly drop: () => void;
	readonly resolve: () => void;
}

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
