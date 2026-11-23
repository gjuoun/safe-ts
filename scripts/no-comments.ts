import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type CommentRange,
	createSourceFile,
	forEachLeadingCommentRange,
	forEachTrailingCommentRange,
	getLeadingCommentRanges,
	getTrailingCommentRanges,
	ScriptTarget,
} from "typescript";

const root = new URL("..", import.meta.url).pathname;
const skip = new Set(["node_modules", "dist", ".git"]);

async function* files(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (skip.has(entry.name)) continue;
		if (entry.isDirectory()) yield* files(path);
		else if (entry.name.endsWith(".ts")) yield path;
	}
}

let violations = 0;
for await (const path of files(root)) {
	const text = await readFile(path, "utf8");
	const sf = createSourceFile(path, text, ScriptTarget.Latest, true);
	const seen = new Set<number>();

	const report = (c: CommentRange) => {
		if (seen.has(c.pos)) return;
		seen.add(c.pos);
		const { line, character } = sf.getLineAndCharacterOfPosition(c.pos);
		const kind = text[c.pos + 1] === "/" ? "line" : "block";
		console.log(`${path.slice(root.length)}:${line + 1}:${character + 1}  ${kind} comment`);
		violations++;
	};

	const visit = (node: import("typescript").Node) => {
		forEachLeadingCommentRange(text, node.getFullStart(), (pos, end) =>
			report({ pos, end, kind: 0, hasTrailingNewLine: false }),
		);
		forEachTrailingCommentRange(text, node.getEnd(), (pos, end) =>
			report({ pos, end, kind: 0, hasTrailingNewLine: false }),
		);
		node.forEachChild(visit);
	};
	visit(sf);

	for (const c of getLeadingCommentRanges(text, 0) ?? []) report(c);
	for (const c of getTrailingCommentRanges(text, sf.getEnd()) ?? []) report(c);
}

if (violations > 0) {
	console.error(`${violations} comment(s) found`);
	process.exit(1);
}
console.log("no-comments: clean");
