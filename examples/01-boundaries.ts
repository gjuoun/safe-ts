import { type Outcome, Runtime, Safe } from "../src/index.ts";

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

const decodeUser = (raw: unknown): { name?: string } => {
	if (typeof raw !== "object" || raw === null) return {};
	const name = "name" in raw ? raw.name : undefined;
	return typeof name === "string" ? { name } : {};
};

const parseJson = (text: string) =>
	Safe.call(
		() => decodeUser(JSON.parse(text)),
		(): "bad_json" => "bad_json",
	);

console.log(show(await Runtime.run(parseJson('{"name":"demo"}'))));
console.log(show(await Runtime.run(parseJson("{"))));

console.log(show(await Runtime.run(Safe.call(() => JSON.parse("{")))));

const failing = (): Promise<string> => Promise.reject(new Error("ECONNREFUSED"));

console.log(
	show(
		await Runtime.run(
			Safe.call(failing, (reason): string =>
				reason instanceof Error ? reason.message : String(reason),
			),
		),
	),
);
console.log(show(await Runtime.run(Safe.call(failing))));

console.log(
	show(
		await Runtime.run(
			Safe.call((s) => s.sleep(500).then(() => "late")),
			{ signal: AbortSignal.timeout(10) },
		),
	),
);
