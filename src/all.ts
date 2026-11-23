import { isThenable, Outcome } from "./outcome.ts";
import { type Ctx, exec, NEVER_ABORTED, Safe } from "./safe.ts";

type AnySafe = Safe<any, any>;

export type AllA<T extends readonly AnySafe[]> = {
	[K in keyof T]: T[K] extends Safe<infer A, any> ? A : never;
};
export type AllE<T extends readonly AnySafe[]> = ErrOf<T[number]>;
type ErrOf<S> = S extends Safe<any, infer E> ? E : never;
export const all = <const T extends readonly AnySafe[]>(safes: T): Safe<AllA<T>, AllE<T>> =>
	new Safe<AllA<T>, AllE<T>>((ctx) => {
		const local = new AbortController();
		const child: Ctx = {
			...ctx,
			signal:
				ctx.signal === NEVER_ABORTED ? local.signal : AbortSignal.any([ctx.signal, local.signal]),
		};
		let first: Outcome<never, AllE<T>> | undefined;
		const note = (exit: Outcome<unknown, unknown>) => {
			if (exit._tag !== "success" && first === undefined) {
				first = exit as Outcome<never, AllE<T>>;
				local.abort();
			}
			return exit;
		};
		const collect = (results: Outcome<unknown, unknown>[]) =>
			first !== undefined
				? first
				: Outcome.succeed(results.map((e) => (e as { value: unknown }).value) as AllA<T>);

		const exits = safes.map((safe) => {
			const out = exec(safe, child);
			return isThenable(out) ? out.then(note, (defect) => note(Outcome.die(defect))) : note(out);
		});

		if (exits.every((exit) => !isThenable(exit))) {
			return collect(exits as Outcome<unknown, unknown>[]);
		}
		return Promise.all(exits).then(collect);
	});

export type AllSettledA<T extends readonly AnySafe[]> = {
	readonly [K in keyof T]: Outcome<AllA<T>[K], T[K] extends Safe<any, infer E> ? E : never>;
};

export const allSettled = <const T extends readonly AnySafe[]>(
	safes: T,
): Safe<AllSettledA<T>, never> =>
	new Safe<AllSettledA<T>, never>((ctx) => {
		const exits = safes.map((safe) => {
			const out = exec(safe, ctx);
			return isThenable(out)
				? out.then(
						(e) => e,
						(defect) => Outcome.die(defect),
					)
				: out;
		});
		if (exits.every((exit) => !isThenable(exit))) {
			return Outcome.succeed(exits as unknown as AllSettledA<T>);
		}
		return Promise.all(exits).then((all) => Outcome.succeed(all as unknown as AllSettledA<T>));
	});
