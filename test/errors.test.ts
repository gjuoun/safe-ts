import { describe, expect, test } from "bun:test";
import { defineErrors, type ErrorsOf, renderError } from "../src/errors.ts";
import { Pipe } from "../src/index.ts";
import { Outcome } from "../src/outcome.ts";
import { run, Safe } from "../src/safe.ts";

const fsError = defineErrors({
	not_found: (path: string) => ({ message: `no such file: ${path}`, path }),
	denied: (path: string, cause: unknown) => ({
		message: `permission denied: ${path}`,
		path,
		cause,
	}),
});
type FsError = ErrorsOf<typeof fsError>;

describe("defineErrors", () => {
	test("wraps the factory's payload under its key", () => {
		expect(fsError.not_found("/a")).toEqual({
			not_found: { message: "no such file: /a", path: "/a" },
		});
	});

	test("adds no field of its own", () => {
		expect(Object.keys(fsError.not_found("/a"))).toEqual(["not_found"]);
	});

	test("cause is preserved", () => {
		const io = new Error("EACCES");
		expect(fsError.denied("/b", io).denied.cause).toBe(io);
	});
});

describe("renderError", () => {
	test("reads the key as the code and the payload's message", () => {
		expect(renderError(fsError.not_found("/a"))).toBe("error: not_found\n\nno such file: /a");
	});

	test("appends the cause", () => {
		expect(renderError(fsError.denied("/b", new Error("EACCES")))).toBe(
			"error: denied\n\npermission denied: /b\ncaused by: EACCES",
		);
	});

	test("a payload with no message still renders", () => {
		const bareError = defineErrors({ offline: () => ({ retries: 3 }) });
		expect(renderError(bareError.offline())).toBe("error: offline");
	});
});

describe("catchTag", () => {
	const read = (path: string): Safe<string, FsError, never> =>
		path === "/ok"
			? Safe.ok("data")
			: path === "/missing"
				? Safe.err(fsError.not_found(path))
				: Safe.err(fsError.denied(path, "EACCES"));

	test("handles the matching key", async () => {
		const recovered = Safe.pipe(read("/missing"), [
			Pipe.catchTag("not_found", (e: { path: string }) => Safe.ok(`default:${e.path}`)),
		]);
		expect(await run(recovered)).toEqual(Outcome.succeed("default:/missing"));
	});

	test("passes other variants through", async () => {
		const exit = await run(
			Safe.pipe(read("/secret"), [Pipe.catchTag("not_found", () => Safe.ok("x"))]),
		);
		expect(exit).toEqual(Outcome.fail(fsError.denied("/secret", "EACCES")));
	});

	test("passes a success through without calling the handler", async () => {
		let calls = 0;
		const exit = await run(
			Safe.pipe(read("/ok"), [
				Pipe.catchTag("not_found", () => {
					calls++;
					return Safe.ok("x");
				}),
			]),
		);
		expect(exit).toEqual(Outcome.succeed("data"));
		expect(calls).toBe(0);
	});
});
