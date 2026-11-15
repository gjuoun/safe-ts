// examples/06-parallel-requests.ts — one failed request cancels its siblings.
//
// Run: bun run examples/06-parallel-requests.ts
import { Clocks, Runtime, Safe } from "../src/index.ts";

const states = new Map<string, string>();

// Fake HTTP client: accepts a signal, like fetch. All five requests start
// together; "c" fails after 10 ms, while the others would take 100 ms.
const http = {
	async getUser(id: string, options: { signal: AbortSignal }): Promise<string> {
		states.set(id, "running");
		try {
			await Clocks.real.sleep(id === "c" ? 10 : 100, options.signal);
			if (id === "c") throw new Error("HTTP 503");
			states.set(id, "success");
			return `user:${id}`;
		} catch (error) {
			states.set(id, options.signal.aborted ? "cancelled" : "failed");
			throw error;
		}
	},
};

const getUser = (id: string) =>
	Safe.call(
		(s) => http.getUser(id, { signal: s.signal }),
		(error) => (error instanceof Error ? error.message : String(error)),
	);

const ids = ["a", "b", "c", "d", "e"];

// Safe.all creates a child signal shared by these calls. When "c" fails,
// the library aborts it; the other clients see that through s.signal.
const outcome = await Runtime.run(Safe.all(ids.map(getUser)));
console.log("batch:", outcome._tag === "fail" ? `fail ${outcome.error}` : outcome._tag);
for (const id of ids) console.log(`${id}: ${states.get(id)}`);

// The batch is fail HTTP 503. Siblings are cancelled (interrupt), not HTTP 503.
// This requires each client to honor its signal; abort cannot stop an API that ignores it.
