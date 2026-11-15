// runtime.ts — the executor, and the services it owns.
//
// `Runtime.run(safe)` runs one Safe whose requirements are all provided.
// `Runtime.make([UserRepo, Db, Config])` owns classes across runs: it builds
// each lazily on first `get`, reuses the instance for every later `run`, and
// disposes it only on `dispose()`. Each `run` still gets its own signal and
// scope, so aborting one request never tears down shared services. The list
// must be closed: every class an `init` gets must be in it. A failed build is
// not cached; the next `run` retries it.
import { isThenable, Outcome } from "./outcome.ts";
import {
	exec,
	type Lookup,
	NEVER_ABORTED,
	type RunOptions,
	rootLookup,
	run,
	type Safe,
} from "./safe.ts";
import { Scope } from "./scope.ts";
import {
	type ClassOf,
	type Entry,
	type EntryDeps,
	type EntryError,
	makeLookup,
} from "./services.ts";

/** Never when every dep of the list is in the list, otherwise the missing classes. */
type Missing<P extends readonly Entry[]> = Exclude<EntryDeps<P[number]>, ClassOf<P[number]>>;

export class Runtime<ROut = never, EOut = never> {
	readonly #entries: readonly Entry[];
	readonly #scope = new Scope();
	readonly #lifetime = new AbortController();
	#disposed = false;
	/** Builds share one lookup; a failed build is replaced so the next run retries. */
	#lookup: Lookup;
	#cachedRunLookup: { readonly shared: Lookup; readonly fn: Lookup } | undefined;

	/** Run a Safe whose requirements are all provided (`R = never`). Never rejects. */
	static run<A, E>(safe: Safe<A, E, never>, options?: RunOptions): Promise<Outcome<A, E>> {
		return run(safe, options);
	}

	/** A runtime that owns `entries` across runs. */
	static make<const P extends readonly Entry[]>(
		entries: P & ([Missing<P>] extends [never] ? unknown : { readonly missing: Missing<P> }),
	): Runtime<ClassOf<P[number]>, EntryError<P[number]>> {
		return new Runtime<ClassOf<P[number]>, EntryError<P[number]>>(entries);
	}

	constructor(entries: readonly Entry[]) {
		this.#entries = entries;
		this.#lookup = this.#buildLookup();
	}

	/**
	 * The per-run lookup wrapper, cached while the shared lookup is unchanged: a
	 * run that never builds a service should not allocate a closure for it.
	 */
	#runLookup(): Lookup {
		const shared = this.#lookup;
		const cached = this.#cachedRunLookup;
		if (cached !== undefined && cached.shared === shared) return cached.fn;
		const fn: Lookup = async (service, path) => {
			const exit = await shared(service, path);
			if (exit._tag !== "success" && this.#lookup === shared) {
				this.#lookup = this.#buildLookup();
			}
			return exit;
		};
		this.#cachedRunLookup = { shared, fn };
		return fn;
	}

	#buildLookup(): Lookup {
		return makeLookup(
			this.#entries,
			{ signal: this.#lifetime.signal, scope: this.#scope, lookup: rootLookup, path: [] },
			this.#scope,
		);
	}

	run<A, E>(safe: Safe<A, E, ROut>, options: RunOptions = {}): Promise<Outcome<A, E | EOut>> {
		if (this.#disposed) {
			return Promise.resolve(Outcome.die(new Error("safe-ts: runtime used after dispose()")));
		}
		const runLookup = this.#runLookup();
		const runScope = new Scope();
		const exit = exec(safe as Safe<A, E | EOut, never>, {
			signal: options.signal ?? NEVER_ABORTED,
			scope: runScope,
			lookup: runLookup,
			path: [],
		});
		// One promise at the public boundary: a sync program resolves it directly.
		return isThenable(exit)
			? exit.then((o) => runScope.close(o))
			: Promise.resolve(runScope.close(exit) as Outcome<A, E | EOut>);
	}

	/** Call `dispose()` on every instance the runtime built, last-built first. Idempotent. */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#lifetime.abort();
		await this.#scope.close(Outcome.succeed(undefined));
	}
}
