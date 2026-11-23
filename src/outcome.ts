export type Outcome<A, E> =
	| { readonly _tag: "success"; readonly value: A }
	| { readonly _tag: "fail"; readonly error: E }
	| { readonly _tag: "die"; readonly defect: unknown }
	| { readonly _tag: "interrupt" };

export const isThenable = (value: unknown): value is PromiseLike<unknown> =>
	value !== null &&
	(typeof value === "object" || typeof value === "function") &&
	typeof (value as { then?: unknown }).then === "function";

export const Outcome = {
	succeed: <A>(value: A): Outcome<A, never> => ({ _tag: "success", value }),
	fail: <E>(error: E): Outcome<never, E> => ({ _tag: "fail", error }),
	die: (defect: unknown): Outcome<never, never> => ({ _tag: "die", defect }),
	interrupt: (): Outcome<never, never> => ({ _tag: "interrupt" }),
	isSuccess: <A, E>(o: Outcome<A, E>): o is Extract<Outcome<A, E>, { _tag: "success" }> =>
		o._tag === "success",
	isFail: <A, E>(o: Outcome<A, E>): o is Extract<Outcome<A, E>, { _tag: "fail" }> =>
		o._tag === "fail",
	isDie: <A, E>(o: Outcome<A, E>): o is Extract<Outcome<A, E>, { _tag: "die" }> => o._tag === "die",
	isInterrupt: <A, E>(o: Outcome<A, E>): o is Extract<Outcome<A, E>, { _tag: "interrupt" }> =>
		o._tag === "interrupt",
};
