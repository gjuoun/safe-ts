// The abstraction tax: cold import time for each library, 5 runs, median + range.
const targets = [
	["safe-ts", new URL("../src/index.ts", import.meta.url).pathname],
	["effect", "effect"],
] as const;

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] as number;
};

for (const [name, spec] of targets) {
	const runs: number[] = [];
	for (let i = 0; i < 5; i++) {
		const t0 = performance.now();
		const proc = Bun.spawn(["bun", "-e", `await import("${spec}")`], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await proc.exited;
		runs.push(performance.now() - t0);
	}
	console.log(
		name.padEnd(9),
		`cold import median ${Math.round(median(runs))} ms`,
		`[${Math.round(Math.min(...runs))}-${Math.round(Math.max(...runs))}]`,
	);
}
