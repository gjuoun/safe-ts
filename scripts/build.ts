// build.ts — bundle to dist/, emit declarations, then rewrite the `.ts` specifiers
// TypeScript leaves in the .d.ts files so a consumer with plain node resolution
// can follow them.
import { readdir, readFile, writeFile } from "node:fs/promises";

const run = (args: string[]) => {
	const proc = Bun.spawnSync(args, { stdout: "inherit", stderr: "inherit" });
	if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
};

run(["bun", "build", "src/index.ts", "--outdir", "dist", "--target", "node", "--format", "esm"]);
run(["bunx", "tsc", "-p", "tsconfig.build.json"]);

let rewritten = 0;
for (const file of await readdir("dist")) {
	if (!file.endsWith(".d.ts")) continue;
	const path = `dist/${file}`;
	const text = await readFile(path, "utf8");
	const fixed = text.replace(/from "(\.\.?\/[^"]*)\.ts"/g, 'from "$1.js"');
	if (fixed !== text) {
		await writeFile(path, fixed);
		rewritten++;
	}
}
console.log(`dist: bundled index.js, ${rewritten} declaration file(s) rewritten to .js specifiers`);
