// all.ts — run Safes concurrently.
//
// Children share one child signal (the run's signal combined with a local
// controller). The first child to fail or die aborts the controller, so its
// siblings stop at their next await, and its outcome becomes the result. An
// outer abort interrupts every child.
import { Outcome } from "./outcome.ts";
import { exec, Safe } from "./safe.ts";

type AnySafe = Safe<any, any, any>;

export type AllA<T extends readonly AnySafe[]> = {
	[K in keyof T]: T[K] extends Safe<infer A, any, any> ? A : never;
};
export type AllE<T extends readonly AnySafe[]> = ErrOf<T[number]>;
export type AllR<T extends readonly AnySafe[]> = ReqOf<T[number]>;

type ErrOf<S> = S extends Safe<any, infer E, any> ? E : never;
type ReqOf<S> = S extends Safe<any, any, infer R> ? R : never;

export const all = <const T extends readonly AnySafe[]>(
	safes: T,
): Safe<AllA<T>, AllE<T>, AllR<T>> =>
	new Safe(async (ctx) => {
		const local = new AbortController();
		const child = { ...ctx, signal: AbortSignal.any([ctx.signal, local.signal]) };
		let first: Outcome<never, AllE<T>> | undefined;
		const exits = await Promise.all(
			safes.map(async (safe) => {
				const exit = await exec(safe, child);
				if (exit._tag !== "success" && first === undefined) {
					first = exit;
					local.abort();
				}
				return exit;
			}),
		);
		if (first !== undefined) return first;
		return Outcome.succeed(
			exits.map((exit) => (exit._tag === "success" ? exit.value : undefined)) as AllA<T>,
		);
	});
