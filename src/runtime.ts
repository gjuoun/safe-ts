// runtime.ts — long-lived class services shared across runs.
//
// `makeRuntime([UserRepo, Db, Config])` builds each class lazily on first
// `get`, reuses the instance for every later `run`, and disposes the
// instances only on `dispose()`. Each `run` still gets its own signal and
// scope, so aborting one request never tears down shared services. The list
// must be closed: every class an `init` gets must be in it. A failed build is not
// cached; the next `run` retries it. Params are passed once, here, and reach
// every `init`.
import { Outcome } from "./outcome.ts";
import { exec, type RunOptions, rootLookup, type Safe } from "./safe.ts";
import { Scope } from "./scope.ts";
import {
	type ClassOf,
	type Entry,
	type EntryDeps,
	type EntryError,
	makeLookup,
	type ParamsArg,
} from "./services.ts";

export interface Runtime<ROut, EOut> {
	run<A, E>(safe: Safe<A, E, ROut>, options?: RunOptions): Promise<Outcome<A, E | EOut>>;
	/** Call `dispose()` on every instance the runtime built, last-built first. Idempotent. */
	dispose(): Promise<void>;
}

/** Never when every dep of the list is in the list, otherwise the missing classes. */
type Missing<P extends readonly Entry[]> = Exclude<EntryDeps<P[number]>, ClassOf<P[number]>>;

export const makeRuntime = <const P extends readonly Entry[], Params = undefined>(
	entries: P & ([Missing<P>] extends [never] ? unknown : { readonly missing: Missing<P> }),
	...rest: ParamsArg<P[number], Params>
): Runtime<ClassOf<P[number]>, EntryError<P[number]>> => {
	const params = rest[0];
	const scope = new Scope();
	const lifetime = new AbortController();
	let disposed = false;
	const makeOwnLookup = () =>
		makeLookup(
			entries,
			{ signal: lifetime.signal, scope, lookup: rootLookup, path: [] },
			scope,
			params,
		);
	// Builds share one lookup; a failed build is forgotten so the next run retries.
	let lookup = makeOwnLookup();

	return {
		async run<A, E>(safe: Safe<A, E, ClassOf<P[number]>>, options: RunOptions = {}) {
			if (disposed) return Outcome.die(new Error("safe-ts: runtime used after dispose()"));
			const shared = lookup;
			const runLookup: typeof lookup = async (service, path) => {
				const exit = await shared(service, path);
				if (exit._tag !== "success" && lookup === shared) lookup = makeOwnLookup();
				return exit;
			};
			const runScope = new Scope();
			const exit = await exec(safe as Safe<A, E | EntryError<P[number]>, never>, {
				signal: options.signal ?? new AbortController().signal,
				scope: runScope,
				lookup: runLookup,
				path: [],
			});
			return runScope.close(exit);
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			lifetime.abort();
			await scope.close(Outcome.succeed(undefined));
		},
	};
};
