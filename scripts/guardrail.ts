const run = (label: string, args: string[]) => {
	const proc = Bun.spawnSync(args, { stdout: "inherit", stderr: "inherit" });
	if (proc.exitCode !== 0) {
		console.error(`guardrail: ${label} failed`);
		process.exit(proc.exitCode ?? 1);
	}
};

const checks: [string, string[]][] = [
	["typecheck", ["bunx", "tsc", "--noEmit"]],
	["biome", ["bunx", "biome", "check", "."]],
	["no-comments", ["bun", "scripts/no-comments.ts"]],
	["test", ["bun", "test"]],
	["docs:check", ["bun", "scripts/doc-check.ts"]],
];

for (const [label, args] of checks) run(label, args);
console.log("guardrail: all gates green");
