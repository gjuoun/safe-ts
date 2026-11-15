// safe-ts vs Effect — parity first, then five trials per scenario.
//
// Both lanes build the program per call: safe-ts's Safe.try and Effect's gen are
// both lazy, so this is the like-for-like model. A "win" is reported only when the
// two lanes' [min-max] ranges do not overlap; overlapping ranges are called noise.
//
//   bun run bench            (TRIALS=5 N=20000 by default)
//   TRIALS=3 N=50000 bun run bench
import * as ef from "./lanes/effect.ts";
import * as st from "./lanes/safe.ts";

const isThenable = (v: unknown) =>
	v !== null &&
	(typeof v === "object" || typeof v === "function") &&
	typeof (v as { then?: unknown }).then === "function";

const TRIALS = Number(process.env.TRIALS ?? 5);
const N = Number(process.env.N ?? 20000);
const ROUNDS = 3;

const SCENARIOS = st.names;

// 1) parity — every lane must print the same string before anything is timed
let mismatches = 0;
for (const name of SCENARIOS) {
	const safe = st.show((await st.run(name)) as never);
	const effect = ef.show(await ef.run(name));
	if (safe !== effect) {
		mismatches++;
		console.log("MISMATCH", name, { safe, effect });
	} else {
		console.log("parity", name.padEnd(12), safe);
	}
}
if (mismatches > 0) {
	console.log("parity FAILED");
	process.exit(1);
}

// 2) timing
const measure = async (fn: () => unknown) => {
	const step = async () => {
		const v = fn();
		if (isThenable(v)) await v;
	};
	for (let i = 0; i < 3000; i++) await step();
	let best = Number.POSITIVE_INFINITY;
	for (let r = 0; r < ROUNDS; r++) {
		Bun.gc(true);
		const t0 = performance.now();
		for (let i = 0; i < N; i++) await step();
		best = Math.min(best, performance.now() - t0);
	}
	return (best * 1e6) / N;
};

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1
		? (s[mid] as number)
		: ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};
const fmt = (v: number) => v.toFixed(0);

console.log("");
console.log(
	"scenario      safe-ts median [min-max]      effect median [min-max]      ratio   verdict",
);
console.log("-".repeat(104));
let wins = 0;
let losses = 0;
for (const name of SCENARIOS) {
	const safe: number[] = [];
	const effect: number[] = [];
	for (let t = 0; t < TRIALS; t++) {
		safe.push(await measure(() => st.run(name)));
		effect.push(await measure(() => ef.run(name)));
	}
	const sm = median(safe);
	const em = median(effect);
	const overlap = Math.max(...safe) >= Math.min(...effect);
	const ratio = sm / em;
	const verdict = overlap ? "noise" : ratio < 1 ? "safe-ts wins" : "effect wins";
	if (!overlap && ratio < 1) wins++;
	if (!overlap && ratio > 1) losses++;
	console.log(
		name.padEnd(13) +
			`${fmt(sm)} [${fmt(Math.min(...safe))}-${fmt(Math.max(...safe))}]`.padEnd(30) +
			`${fmt(em)} [${fmt(Math.min(...effect))}-${fmt(Math.max(...effect))}]`.padEnd(30) +
			ratio.toFixed(2).padStart(6) +
			"   " +
			verdict,
	);
}
console.log("-".repeat(104));
console.log(
	"safe-ts wins " +
		wins +
		", effect wins " +
		losses +
		", rest within noise  (TRIALS=" +
		TRIALS +
		", N=" +
		N +
		")",
);
