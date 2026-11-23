import { Outcome } from "./outcome.ts";

export type Finalizer = (outcome: Outcome<unknown, unknown>) => void | PromiseLike<void>;

export class Scope {
	readonly #finalizers: Finalizer[] = [];
	#closed = false;

	get closed(): boolean {
		return this.#closed;
	}

	add(finalizer: Finalizer): void {
		if (this.#closed) throw new Error("safe-ts: finalizer added to a closed scope");
		this.#finalizers.push(finalizer);
	}

	close<A, E>(outcome: Outcome<A, E>): Outcome<A, E> | Promise<Outcome<A, E>> {
		if (this.#closed) return outcome;
		this.#closed = true;
		if (this.#finalizers.length === 0) return outcome;
		return this.#closeAsync(outcome);
	}

	async #closeAsync<A, E>(outcome: Outcome<A, E>): Promise<Outcome<A, E>> {
		let defect: { readonly value: unknown } | undefined;
		for (const finalizer of this.#finalizers.reverse()) {
			try {
				await finalizer(outcome);
			} catch (thrown) {
				defect ??= { value: thrown };
			}
		}
		this.#finalizers.length = 0;
		return defect !== undefined && outcome._tag === "success" ? Outcome.die(defect.value) : outcome;
	}
}
