export interface PolicyState<E> {
	readonly attempt: number;
	readonly error: E;

	readonly elapsed: number;
}

export type Policy<E> = (state: PolicyState<E>) => number | undefined;

export type PolicyOp<E> = (policy: Policy<E>) => Policy<E>;

type AnyPolicy = Policy<any>;
type AnyPolicyOp = PolicyOp<any>;

export const Policy = {
	forever: ((_) => 0) satisfies AnyPolicy as AnyPolicy,

	spaced:
		(ms: number): AnyPolicy =>
		(_) =>
			ms,

	exponential:
		(base: number, factor = 2): AnyPolicy =>
		(s) =>
			base * factor ** (s.attempt - 1),

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

	while:
		(pred: (state: PolicyState<any>) => boolean): AnyPolicyOp =>
		(policy) =>
		(s) =>
			pred(s) ? policy(s) : undefined,

	modifyDelay:
		(f: (delay: number, state: PolicyState<any>) => number): AnyPolicyOp =>
		(policy) =>
		(s) => {
			const d = policy(s);
			return d === undefined ? undefined : f(d, s);
		},

	pipe: (policy: AnyPolicy, ops: readonly AnyPolicyOp[] = []): AnyPolicy =>
		ops.reduce((acc, op) => op(acc), policy),
};
