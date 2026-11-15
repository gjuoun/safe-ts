import { describe, expect, test } from "bun:test";
import { Policy, type PolicyState } from "../src/policy.ts";

type State = PolicyState<string>;
const st = (attempt: number, error = "e", elapsed = 0): State => ({ attempt, error, elapsed });

/** Run a policy against a list of attempts and collect the delays it returns. */
const trace = (p: Policy<string>, attempts: number): (number | undefined)[] => {
	const out: (number | undefined)[] = [];
	for (let a = 1; a <= attempts; a++) {
		out.push(p(st(a)));
	}
	return out;
};

describe("Policy algebra", () => {
	test("spaced returns the same delay every time", () => {
		expect(trace(Policy.spaced(250), 4)).toEqual([250, 250, 250, 250]);
	});

	test("exponential doubles each attempt", () => {
		expect(trace(Policy.exponential(250), 4)).toEqual([250, 500, 1000, 2000]);
	});

	test("min caps the backoff at the spaced delay", () => {
		expect(trace(Policy.min([Policy.exponential(250), Policy.spaced(1000)]), 4)).toEqual([
			250, 500, 1000, 1000,
		]);
	});

	test("a gate inside max stops the whole thing", () => {
		const gated = Policy.max([
			Policy.exponential(250),
			Policy.pipe(Policy.forever, [Policy.while((s) => s.attempt <= 2)]),
		]);
		expect(trace(gated, 4)).toEqual([250, 500, undefined, undefined]);
	});

	test("Policy.pipe folds transformers left to right", () => {
		const jittered = Policy.pipe(Policy.spaced(100), [
			Policy.modifyDelay((d) => d * 2),
			Policy.while((s) => s.attempt <= 2),
		]);
		expect(trace(jittered, 4)).toEqual([200, 200, undefined, undefined]);
	});

	test("forever alone is an unbounded gate", () => {
		expect(trace(Policy.forever, 3)).toEqual([0, 0, 0]);
	});

	test("the object sugar equals spaced + while attempt", () => {
		// What { attempts: 3, delayMs: 10 } compiles to internally:
		const sugar = Policy.pipe(Policy.spaced(10), [Policy.while((s) => s.attempt < 3)]);
		expect(trace(sugar, 5)).toEqual([10, 10, undefined, undefined]);
	});

	test("a bare transformer is a PolicyOp, not a Policy — the type rejects it", () => {
		// @ts-expect-error a transformer is not a policy: it needs Policy.pipe
		const bad: Policy<string> = Policy.while((s: State) => s.attempt <= 2);
		expect(bad).toBeDefined();
	});
});
