import { describe, expect, test } from "bun:test";
import { Clocks } from "../src/clock.ts";
import { Outcome } from "../src/outcome.ts";
import { run, Safe } from "../src/safe.ts";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("Clocks.manual", () => {
	test("Safe.delay waits on the manual clock", async () => {
		const { clock, advance } = Clocks.manual();
		const started = Date.now();
		const pending = run(Safe.delay(30_000), { clock });
		await flush();
		advance(30_000);
		const exit = await pending;
		expect(exit).toEqual(Outcome.succeed(undefined));
		expect(Date.now() - started).toBeLessThan(50);
	});

	test("a timeout deadline is virtual too", async () => {
		const { clock, advance } = Clocks.manual();
		const { Pipe } = await import("../src/index.ts");
		const body = Safe.call(async (s) => {
			await s.sleep(100);
			return "done";
		});
		const pending = run(body.pipe(Pipe.timeout(10)), { clock });
		await flush();
		advance(10);
		const exit = await pending;
		expect(exit).toEqual(Outcome.interrupt());
	});

	test("s.now reads the manual clock", async () => {
		const { clock, advance } = Clocks.manual();
		advance(1234);
		const exit = await run(
			Safe.call((s) => s.now()),
			{ clock },
		);
		expect(exit).toEqual(Outcome.succeed(1234));
	});

	test("an abort still interrupts a virtual wait", async () => {
		const { clock } = Clocks.manual();
		const ac = new AbortController();
		const pending = run(Safe.delay(1_000), { clock, signal: ac.signal });
		await flush();
		ac.abort();
		expect(await pending).toEqual(Outcome.interrupt());
	});
});
