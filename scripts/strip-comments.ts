import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createSourceFile,
	forEachLeadingCommentRange,
	forEachTrailingCommentRange,
	getLeadingCommentRanges,
	getTrailingCommentRanges,
	ScriptTarget,
} from "typescript";

const root = new URL("..", import.meta.url).pathname;
const skip = new Set(["node_modules", "dist", ".git", "COMMENTARCHIVE"]);

async function* files(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (skip.has(entry.name)) continue;
		if (entry.isDirectory()) yield* files(path);
		else if (entry.name.endsWith(".ts")) yield path;
	}
}

const archive: string[] = ["# Comments removed from source — reference only\n"];

for await (const path of files(root)) {
	const text = await readFile(path, "utf8");
	const sf = createSourceFile(path, text, ScriptTarget.Latest, true);
	const ranges: { pos: number; end: number }[] = [];
	const seen = new Set<number>();
	const note = (pos: number, end: number) => {
		if (!seen.has(pos)) {
			seen.add(pos);
			ranges.push({ pos, end });
		}
	};

	const visit = (node: import("typescript").Node) => {
		forEachLeadingCommentRange(text, node.getFullStart(), note);
		forEachTrailingCommentRange(text, node.getEnd(), note);
		node.forEachChild(visit);
	};
	visit(sf);
	for (const c of getLeadingCommentRanges(text, 0) ?? []) note(c.pos, c.end);
	for (const c of getTrailingCommentRanges(text, sf.getEnd()) ?? []) note(c.pos, c.end);

	const strip = ranges
		.filter((r) => !(r.pos === 0 && text.startsWith("#!")))
		.sort((a, b) => b.pos - a.pos);

	if (strip.length === 0) continue;

	let out = text;
	for (const { pos, end } of strip) {
		out = out.slice(0, pos) + out.slice(end);
		archive.push(`\n--- \n\n\${path.slice(root.length)}:\n${text.slice(pos, end)}`);
	}
	await writeFile(path, out);
	console.log(`stripped ${strip.length} from ${path.slice(root.length)}`);
}

await writeFile(join(root, "COMMENTS-ARCHIVED.md"), archive.join(""));
