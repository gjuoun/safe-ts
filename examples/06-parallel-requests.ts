import { Clocks, Runtime, Safe } from "../src/index.ts";

const states = new Map<string, string>();

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

const outcome = await Runtime.run(Safe.all(ids.map(getUser)));
console.log("batch:", outcome._tag === "fail" ? `fail ${outcome.error}` : outcome._tag);
for (const id of ids) console.log(`${id}: ${states.get(id)}`);
