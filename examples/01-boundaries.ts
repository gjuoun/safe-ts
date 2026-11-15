// examples/01-boundaries.ts — one boundary, one rule.
//
// Everything that can throw enters the library through `Safe.call`, sync or
// async. The rule is the same for both: declare a mapper and the throw becomes
// a typed `fail`; omit it and the throw is a `die` — a defect, not something
// you declared. The callback gets a `Scheduler`, which owns cancellation.
//
//   bun run examples/01-boundaries.ts
import { type Outcome, Safe } from "../src/index.ts";

const show = <A, E>(exit: Outcome<A, E>): string => {
	switch (exit._tag) {
		case "success":
			return `ok: ${JSON.stringify(exit.value)}`;
		case "fail":
			return `fail: ${JSON.stringify(exit.error)}`;
		case "die":
			return `die: ${String(exit.defect)}`;
		case "interrupt":
			return "interrupt";
	}
};

// A mapper makes the throw a typed error: the bad case rides the error channel.
const parseJson = (text: string) =>
	Safe.call(
		() => JSON.parse(text) as { name?: string },
		(): "bad_json" => "bad_json",
	);

console.log(show(await Safe.run(parseJson('{"name":"demo"}'))));
console.log(show(await Safe.run(parseJson("{"))));

// The same call with no mapper: the throw is a defect, not a typed error.
console.log(show(await Safe.run(Safe.call(() => JSON.parse("{")))));

// A promise that rejects, mapped and unmapped.
const failing = (): Promise<string> => Promise.reject(new Error("ECONNREFUSED"));

console.log(
	show(await Safe.run(Safe.call(failing, (reason): string => (reason as Error).message))),
);
console.log(show(await Safe.run(Safe.call(failing))));

// `Scheduler.sleep` is cancelled by the run's signal — there is no listener to
// wire by hand, and none to forget.
console.log(
	show(
		await Safe.run(
			Safe.call((s) => s.sleep(500).then(() => "late")),
			{ signal: AbortSignal.timeout(10) },
		),
	),
);
