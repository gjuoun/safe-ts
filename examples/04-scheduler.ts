// examples/04-scheduler.ts — start with HTTP, then a database without signal support.
//
// Run: bun run examples/04-scheduler.ts
// Safe.call runs only when Runtime.run is called. It gives each call a Scheduler (s).
import { Clocks, type Outcome, Runtime, Safe } from "../src/index.ts";

interface User {
	readonly id: string;
	readonly name: string;
}

// Fake HTTP client: like fetch, it accepts an AbortSignal.
const http = {
	async getUser(id: string, options: { signal: AbortSignal }): Promise<User> {
		await Clocks.real.sleep(20, options.signal);
		if (id === "missing") throw new Error("HTTP 404");
		return { id, name: "Ada" };
	},
};

// Fake DB client: it cannot accept an AbortSignal, but returns a cancel function.
const db = {
	cancelled: 0,
	queryUser(id: string, cancelFails = false) {
		let stop = () => {};
		const result = new Promise<User>((resolve, reject) => {
			const timer = setTimeout(() => resolve({ id, name: "Ada" }), 30);
			stop = () => {
				clearTimeout(timer);
				this.cancelled++;
				reject(new Error("query cancelled"));
				if (cancelFails) throw new Error("DB cancel failed");
			};
		});
		return { result, cancel: () => stop() };
	},
};

const show = (exit: Outcome<unknown, unknown>): string => {
	if (exit._tag === "success") return `success ${JSON.stringify(exit.value)}`;
	if (exit._tag === "fail") return `fail ${JSON.stringify(exit.error)}`;
	if (exit._tag === "die") return `die ${String(exit.defect)}`;
	return "interrupt";
};

// 1. Normal HTTP call. No cancellation requested: just pass s.signal to the client.
const getUser = (id: string) =>
	Safe.call(
		(s) => http.getUser(id, { signal: s.signal }),
		(error) => `HTTP request failed: ${String(error)}`,
	);
console.log("1 HTTP success  ", show(await Runtime.run(getUser("u1"))));

// 2. A normal HTTP error goes through mapErr and becomes a typed fail.
console.log("2 HTTP 404      ", show(await Runtime.run(getUser("missing"))));

// 3. The caller cancels an in-flight HTTP request. No onCancel is needed:
//    the client already understands s.signal. Cancellation is interrupt, not fail.
console.log(
	"3 HTTP cancelled",
	show(await Runtime.run(getUser("u1"), { signal: AbortSignal.timeout(5) })),
);

// 4. A DB client with no signal support still works normally.
const findUser = (id: string, cancelFails = false) =>
	Safe.call((s) => {
		const query = db.queryUser(id, cancelFails);
		s.onCancel(query.cancel);
		return query.result;
	});
console.log("4 DB success    ", show(await Runtime.run(findUser("u2"))));

// 5. To cancel that DB query, onCancel calls the client's cancel method.
//    The query rejects, but Safe.call reports interrupt because the run was aborted.
console.log(
	"5 DB cancelled  ",
	show(await Runtime.run(findUser("u2"), { signal: AbortSignal.timeout(5) })),
	`| cancel called ${db.cancelled} time(s)`,
);

// 6. For a wait, use s.sleep instead of managing a timer or listener yourself.
//    A manual clock makes this one-second wait immediate in tests.
const { clock, advance } = Clocks.manual();
const waiting = Runtime.run(
	Safe.call((s) => s.sleep(1000).then(() => "awake")),
	{ clock },
);
advance(1000);
console.log("6 sleep         ", show(await waiting));

// 7. If DB cancellation itself throws, that is a defect (die), not an interrupt.
//    This is an exceptional cleanup failure, not how normal cancellation looks.
console.log(
	"7 cancel throws ",
	show(await Runtime.run(findUser("u3", true), { signal: AbortSignal.timeout(5) })),
);
