import { expect, test } from "bun:test";

test("user-service example prints its 4 lines in order", async () => {
	const proc = Bun.spawn(["bun", "run", "examples/user-service.ts"], {
		cwd: `${import.meta.dir}/..`,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	expect(code).toBe(0);
	expect(stdout.trim().split("\n")).toEqual([
		"found: ada",
		"handled: not_found u2",
		"interrupt",
		"db: closed",
	]);
});
