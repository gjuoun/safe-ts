// runtime.ts — the executor, and the services it owns.
//
// `Runtime.run(safe)` runs one Safe whose requirements are all provided.
// `Runtime.make([UserRepo, Db, Config])` owns classes across runs: it builds
// each lazily on first `get`, reuses the instance for every later `run`, and
// disposes it only on `dispose()`. Each `run` still gets its own signal and
// scope, so aborting one request never tears down shared services. The list
// must be closed: every class an `init` gets must be in it. A failed build is
// not cached; the next `run` retries it.
import { Outcome } from "./outcome.ts";
import { exec, type Lookup, type RunOptions, rootLookup, run, type Safe } from "./safe.ts";
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
		const shared = this.#lookup;
		const runLookup: Lookup = async (service, path) => {
			const exit = await shared(service, path);
			if (exit._tag !== "success" && this.#lookup === shared) {
				this.#lookup = this.#buildLookup();
			}
			return exit;
		};
		const runScope = new Scope();
		return exec(safe as Safe<A, E | EOut, never>, {
			signal: options.signal ?? new AbortController().signal,
			scope: runScope,
			lookup: runLookup,
			path: [],
		}).then((exit) => runScope.close(exit));
	}

	/** Call `dispose()` on every instance the runtime built, last-built first. Idempotent. */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#lifetime.abort();
		await this.#scope.close(Outcome.succeed(undefined));
	}
}
