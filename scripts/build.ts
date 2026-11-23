import { rm } from "node:fs/promises";

const run = (args: string[]) => {
	const proc = Bun.spawnSync(args, { stdout: "inherit", stderr: "inherit" });
	if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
};

await rm("dist", { recursive: true, force: true });

run(["bun", "build", "src/index.ts", "--outdir", "dist", "--target", "node", "--format", "esm"]);
run([
	"bunx",
	"dts-bundle-generator",
	"-o",
	"dist/index.d.ts",
	"src/index.ts",
	"--project",
	"tsconfig.json",
	"--no-check",
]);

const bundle = Bun.file("dist/index.js");
const types = Bun.file("dist/index.d.ts");
console.log(
	`dist: index.js ${(bundle.size / 1024).toFixed(1)} KB, index.d.ts ${(types.size / 1024).toFixed(1)} KB`,
);
