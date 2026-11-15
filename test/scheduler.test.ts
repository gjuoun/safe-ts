import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { Outcome } from "../src/outcome.ts";
import { run, Safe } from "../src/safe.ts";
import { Scheduler } from "../src/scheduler.ts";

const live = (signal: AbortSignal) => getEventListeners(signal, "abort").length;

describe("Scheduler", () => {
	test("sleep resolves after its delay", async () => {
		const started = performance.now();
		await new Scheduler(new AbortController().signal).sleep(5);
		expect(performance.now() - started).toBeGreaterThanOrEqual(4);
	});

	test("sleep rejects when the run is cancelled", async () => {
		const ac = new AbortController();
		const scheduler = new Scheduler(ac.signal);
		const pending = scheduler.sleep(500);
		ac.abort();
		let rejected = false;
		try {
			await pending;
		} catch {
			rejected = true;
		}
		expect(rejected).toBe(true);
	});

	test("onCancel runs immediately when the signal already fired", () => {
		const ac = new AbortController();
		ac.abort();
		let ran = 0;
		new Scheduler(ac.signal).onCancel(() => {
			ran++;
		});
		expect(ran).toBe(1);
	});

	test("onCancel unregisters with the returned function", async () => {
		const ac = new AbortController();
		let ran = 0;
		const dispose = new Scheduler(ac.signal).onCancel(() => {
			ran++;
		});
		dispose();
		ac.abort();
		expect(ran).toBe(0);
	});

	test("signal is the run's own signal", async () => {
		const ac = new AbortController();
		expect(
			await run(
				Safe.call((s) => s.signal === ac.signal),
				{ signal: ac.signal },
			),
		).toEqual(Outcome.succeed(true));
	});
});

describe("Safe.call owns the listener", () => {
	test("100 settled calls leave no abort listener behind", async () => {
		const lifetime = new AbortController();
		for (let i = 0; i < 100; i++) {
			await run(
				Safe.call(() => i),
				{ signal: lifetime.signal },
			);
		}
		expect(live(lifetime.signal)).toBe(0);
	});

	test("a cancelled call leaves no listener either", async () => {
		const ac = new AbortController();
		const pending = run(
			Safe.call((s) => s.sleep(500)),
			{ signal: ac.signal },
		);
		setTimeout(() => ac.abort(), 1);
		expect(await pending).toEqual(Outcome.interrupt());
		expect(live(ac.signal)).toBe(0);
	});
});
