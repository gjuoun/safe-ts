// examples/02-safe-try.ts — `Safe.try`: sequenced steps over a lazy `Safe`.
//
// `Safe.try` describes work; nothing runs until `run`, and each `run` runs the
// body again. Inside the body `yield*` unwraps a Safe — a failure stops the
// body there — and `return value` succeeds. A body that stops early still runs
// its `finally` blocks (neverthrow #696).
//
//   bun run examples/02-safe-try.ts
import { readFile, writeFile } from "node:fs/promises";
import { type Outcome, Safe } from "../src/index.ts";

interface Config {
	name: string;
}

// The boundary: a throwing call becomes a typed failure.
const parseJson = (text: string) =>
	Safe.call(
		() => JSON.parse(text) as Config,
		(): "bad_json" => "bad_json",
	);

// A sync body can still yield async Safes — `yield*` is the sequencing, not `await`.
const readConfig = (text: string) =>
	Safe.try(function* () {
		const config = yield* parseJson(text); // Safe<Config, "bad_json", never>
		if (!config.name) return yield* Safe.err("missing_name"); // an early failure
		return config;
	}); // Safe<Config, "bad_json" | "missing_name", never>

const loadConfig = (path: string) =>
	Safe.try(function* () {
		// The async boundary: a rejection becomes a typed failure.
		const text = yield* Safe.call(
			() => readFile(path, "utf8"),
			(): "unreadable" => "unreadable",
		);
		return yield* readConfig(text);
	}); // Safe<Config, "unreadable" | "bad_json" | "missing_name", never>

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

await writeFile("/tmp/safe-ts-config.json", JSON.stringify({ name: "demo" }));
console.log(show(await Safe.run(loadConfig("/tmp/safe-ts-config.json"))));
console.log(show(await Safe.run(loadConfig("/tmp/safe-ts-missing.json"))));

// Lazy: build once, and every `run` runs the body again.
let runs = 0;
const counted = Safe.try(function* () {
	runs += 1;
	yield* Safe.ok(undefined); // a yieldable step
	return runs;
});
console.log(`${show(await Safe.run(counted))} then ${show(await Safe.run(counted))}`);

// A failed `yield*` closes the generator — `finally` still runs.
const cleanup = Safe.try(function* () {
	try {
		return yield* Safe.err("stopped");
	} finally {
		console.log("finally: still ran");
	}
});
console.log(show(await Safe.run(cleanup)));
