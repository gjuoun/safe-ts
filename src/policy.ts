// policy.ts — a retry policy is a value.
//
// A `Policy<E>` is a plain function: given the attempt that just failed, how
// many ms to wait before the next attempt — or `undefined` to stop and return
// the error. It decides, it never waits: `retry` performs the sleep on the
// run's clock, so a policy is pure and testable.
//
// `Policy` is also a namespace. Its members are the whole algebra, closed at
// eight: three constructors, two composers and two transformers, plus `pipe`.
// Gates go in `max`, caps go in `min`; `while` and `modifyDelay` are
// transformers — a `Policy → Policy` — so a bare one fed to `retry` is a
// compile error, not a runtime surprise.
/** What a policy sees, for the attempt that just failed (1-based). */
export interface PolicyState<E> {
	readonly attempt: number;
	readonly error: E;
	/** ms since the first attempt started. */
	readonly elapsed: number;
}

/** A retry policy: ms to wait before the next attempt, or `undefined` to stop. */
export type Policy<E> = (state: PolicyState<E>) => number | undefined;

/** A policy transformer: `Policy → Policy`, the shape `Policy.pipe` folds. */
export type PolicyOp<E> = (policy: Policy<E>) => Policy<E>;

type AnyPolicy = Policy<any>;
type AnyPolicyOp = PolicyOp<any>;

export const Policy = {
	/** Always 0 delay, never stops — the base a bare `while` gate is built on. */
	forever: ((_) => 0) satisfies AnyPolicy as AnyPolicy,

	/** Wait `ms` before every retry. */
	spaced:
		(ms: number): AnyPolicy =>
		(_) =>
			ms,

	/** Wait `base * factor ^ (attempt - 1)` before each retry (factor 2). */
	exponential:
		(base: number, factor = 2): AnyPolicy =>
		(s) =>
			base * factor ** (s.attempt - 1),

	/** Continue while at least one branch continues; the shorter delay wins. A cap. */
	min:
		<T extends readonly AnyPolicy[]>(policies: T): AnyPolicy =>
		(s) => {
			let best: number | undefined;
			for (const p of policies) {
				const d = p(s);
				if (d !== undefined) best = best === undefined ? d : Math.min(best, d);
			}
			return best;
		},

	/** Stop when any branch stops; the longer delay wins. The gate goes here. */
	max:
		<T extends readonly AnyPolicy[]>(policies: T): AnyPolicy =>
		(s) => {
			let best = 0;
			for (const p of policies) {
				const d = p(s);
				if (d === undefined) return undefined;
				best = Math.max(best, d);
			}
			return best;
		},

	/** Continue while `pred` holds; stop — the whole branch ends — when it does not. */
	while:
		(pred: (state: PolicyState<any>) => boolean): AnyPolicyOp =>
		(policy) =>
		(s) =>
			pred(s) ? policy(s) : undefined,

	/** Replace the delay a policy computed — jitter is `modifyDelay`. */
	modifyDelay:
		(f: (delay: number, state: PolicyState<any>) => number): AnyPolicyOp =>
		(policy) =>
		(s) => {
			const d = policy(s);
			return d === undefined ? undefined : f(d, s);
		},

	/** Fold transformers left to right: `Policy.pipe(p, [t1, t2])` = `t2(t1(p))`. */
	pipe: (policy: AnyPolicy, ops: readonly AnyPolicyOp[] = []): AnyPolicy =>
		ops.reduce((acc, op) => op(acc), policy),
};
