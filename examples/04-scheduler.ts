import { Clocks, type Outcome, Runtime, Safe } from "../src/index.ts";

interface User {
	readonly id: string;
	readonly name: string;
}

const http = {
	async getUser(id: string, options: { signal: AbortSignal }): Promise<User> {
		await Clocks.real.sleep(20, options.signal);
		if (id === "missing") throw new Error("HTTP 404");
		return { id, name: "Ada" };
	},
};

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

const getUser = (id: string) =>
	Safe.call(
		(s) => http.getUser(id, { signal: s.signal }),
		(error) => `HTTP request failed: ${String(error)}`,
	);
console.log("1 HTTP success  ", show(await Runtime.run(getUser("u1"))));

console.log("2 HTTP 404      ", show(await Runtime.run(getUser("missing"))));

console.log(
	"3 HTTP cancelled",
	show(await Runtime.run(getUser("u1"), { signal: AbortSignal.timeout(5) })),
);

const findUser = (id: string, cancelFails = false) =>
	Safe.call((s) => {
		const query = db.queryUser(id, cancelFails);
		s.onCancel(query.cancel);
		return query.result;
	});
console.log("4 DB success    ", show(await Runtime.run(findUser("u2"))));

console.log(
	"5 DB cancelled  ",
	show(await Runtime.run(findUser("u2"), { signal: AbortSignal.timeout(5) })),
	`| cancel called ${db.cancelled} time(s)`,
);

const { clock, advance } = Clocks.manual();
const waiting = Runtime.run(
	Safe.call((s) => s.sleep(1000).then(() => "awake")),
	{ clock },
);
advance(1000);
console.log("6 sleep         ", show(await waiting));

console.log(
	"7 cancel throws ",
	show(await Runtime.run(findUser("u3", true), { signal: AbortSignal.timeout(5) })),
);
