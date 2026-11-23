import { readFile, writeFile } from "node:fs/promises";
import { type Outcome, Runtime, Safe } from "../src/index.ts";

interface Config {
	name: string;
}

const parseJson = (text: string) =>
	Safe.call(
		() => JSON.parse(text) as Config,
		(): "bad_json" => "bad_json",
	);

const readConfig = (text: string) =>
	Safe.try(function* () {
		const config = yield* parseJson(text);
		if (!config.name) return yield* Safe.err("missing_name");
		return config;
	});

const loadConfig = (path: string) =>
	Safe.try(function* () {
		const text = yield* Safe.call(
			() => readFile(path, "utf8"),
			(): "unreadable" => "unreadable",
		);
		return yield* readConfig(text);
	});

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
console.log(show(await Runtime.run(loadConfig("/tmp/safe-ts-config.json"))));
console.log(show(await Runtime.run(loadConfig("/tmp/safe-ts-missing.json"))));

let runs = 0;
const counted = Safe.try(function* () {
	runs += 1;
	yield* Safe.ok(undefined);
	return runs;
});
console.log(`${show(await Runtime.run(counted))} then ${show(await Runtime.run(counted))}`);

const cleanup = Safe.try(function* () {
	try {
		return yield* Safe.err("stopped");
	} finally {
		console.log("finally: still ran");
	}
});
console.log(show(await Runtime.run(cleanup)));
