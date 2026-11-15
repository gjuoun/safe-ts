// doc-check.ts — every ```ts block in docs/ must compile against the library.
// The docs import from "safe-ts"; here that resolves to src/index.ts, so a block
// that drifts from the real API fails the check instead of misleading a reader.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
const entry = root + "src/index.ts";
const out = "/tmp/jun/doc-check";

await mkdir(out, { recursive: true });
const files: string[] = [];
let blocks = 0;

for (const lang of ["en", "zh"]) {
	const dir = `${root}docs/${lang}`;
	for (const file of await readdir(dir)) {
		if (!file.endsWith(".md")) continue;
		const text = await readFile(`${dir}/${file}`, "utf8");
		const found = text.matchAll(/```ts\n([\s\S]*?)```/g);
		let i = 0;
		for (const match of found) {
			const code = (match[1] ?? "").replaceAll('from "safe-ts"', `from "${entry}"`);
			const path = `${out}/${lang}-${file.replace(/\.md$/, "")}-${i++}.ts`;
			await writeFile(path, code);
			files.push(path);
			blocks++;
		}
	}
}

console.log(`doc-check: ${blocks} blocks from ${files.length === 0 ? 0 : "docs"} → ${out}`);
if (files.length === 0) process.exit(0);

const proc = Bun.spawnSync(
	[
		"bunx",
		"tsc",
		"--noEmit",
		"--strict",
		"--target",
		"esnext",
		"--module",
		"esnext",
		"--moduleResolution",
		"bundler",
		"--skipLibCheck",
		"--allowImportingTsExtensions",
		"--types",
		"bun",
		...files,
	],
	{ stdout: "inherit", stderr: "inherit" },
);
if (proc.exitCode !== 0) {
	console.log("doc-check FAILED");
	process.exit(proc.exitCode ?? 1);
}
console.log(`doc-check: ${blocks} blocks typecheck`);
