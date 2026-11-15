// examples/04-scheduler.ts — what `Safe.call` hands your callback, and what it does on abort.
//
// A Scheduler is per call, bound to that run's signal and clock. You never build
// one. This file walks every member and every surprising exit, so the behaviour
// is something you have read rather than something you guess:
//
//   s.signal    → give it to APIs that take an AbortSignal (fetch, drivers)
//   s.onCancel  → for what cannot take one (timers, sockets, workers)
//   s.sleep     → a cancellable wait, virtual on a manual clock
//   s.now       → the run's clock
//
//   bun run examples/04-scheduler.ts
import { Clocks, type Outcome, Runtime, Safe } from "../src/index.ts";

const show = (exit: Outcome<unknown, unknown>): string => {
	if (exit._tag === "success") return `success ${JSON.stringify(exit.value)}`;
	if (exit._tag === "fail") return `fail ${JSON.stringify(exit.error)}`;
	return exit._tag;
};

// 1 · s.signal is the run's signal: aborting the run aborts the work.
{
	const client = new AbortController();
	const work = Safe.call(
		(s) =>
			new Promise<string>((_resolve, reject) => {
				s.signal.addEventListener("abort", () => reject(new Error("aborted")));
			}),
		// Declared, but a cancel never reaches it — see 2 for the non-cancelled case.
		(e) => `mapped: ${String(e)}`,
	);
	setTimeout(() => client.abort(), 10);
	console.log("1 signal         ", show(await Runtime.run(work, { signal: client.signal })));
}

// 2 · Without a cancel, the same rejection *is* a typed failure: `mapErr` runs.
{
	const work = Safe.call(
		async () => {
			throw new Error("ECONNRESET");
		},
		(e) => `mapped: ${String(e)}`,
	);
	console.log("2 plain rejection", show(await Runtime.run(work)));
}

// 3 · onCancel is for resources that cannot take a signal. The timer is cleared
//     when the run is cancelled, so nothing fires afterwards.
{
	const client = new AbortController();
	let cleared = 0;
	const work = Safe.call(
		(s) =>
			new Promise<string>((resolve) => {
				const timer = setTimeout(() => resolve("too late"), 50);
				s.onCancel(() => {
					clearTimeout(timer);
					cleared++;
				});
			}),
	);
	setTimeout(() => client.abort(), 5);
	const exit = await Runtime.run(work, { signal: client.signal });
	console.log("3 onCancel       ", show(exit), `| cleared ${cleared} timer`);
}

// 4 · A throwing cleanup is a defect, not a swallowed error.
{
	const client = new AbortController();
	const work = Safe.call((s) => {
		s.onCancel(() => {
			throw new Error("cleanup failed");
		});
		return new Promise<string>(() => {});
	});
	setTimeout(() => client.abort(), 5);
	console.log("4 throwing cancel", show(await Runtime.run(work, { signal: client.signal })));
}

// 5 · Callbacks are released when the call settles: an abort that arrives later
//     does not run them.
{
	const client = new AbortController();
	let after = 0;
	const exit = await Runtime.run(
		Safe.call((s) => {
			s.onCancel(() => after++);
			return "done";
		}),
		{ signal: client.signal },
	);
	client.abort();
	console.log("5 settled first  ", show(exit), `| callbacks run after abort: ${after}`);
}

// 6 · sleep reads the run's clock. A manual clock makes a one-second wait free,
//     and an abort during the wait is an interrupt.
{
	const { clock, advance } = Clocks.manual();
	const work = Safe.call((s) => s.sleep(1000).then(() => "woke"));
	const pending = Runtime.run(work, { clock });
	advance(1000);
	console.log("6 manual sleep   ", show(await pending));

	const client = new AbortController();
	const waiting = Safe.call((s) => s.sleep(1000).then(() => "woke"));
	setTimeout(() => client.abort(), 5);
	console.log("7 sleep cancelled", show(await Runtime.run(waiting, { signal: client.signal })));
}
