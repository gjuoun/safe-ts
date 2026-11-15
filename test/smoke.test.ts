import { expect, test } from "bun:test";
import * as safe from "../src/index.ts";

test("entry exports the one surface", () => {
	expect(safe.VERSION).toBe("0.1.0");
	for (const name of [
		"all",
		"defineErrors",
		"renderError",
		"Outcome",
		"makeRuntime",
		"run",
		"Safe",
		"Scheduler",
		"get",
		"provide",
		"override",
	]) {
		expect(name in safe).toBe(true);
	}
});

test("the eager second system is gone", () => {
	for (const name of [
		"Result",
		"Ok",
		"Err",
		"ok",
		"err",
		"isResult",
		"fromThrowable",
		"fromPromise",
		"catchTag",
		"Exit",
		"Cause",
		"safeTry",
	]) {
		expect(name in safe).toBe(false);
	}
});

test("Safe exposes one answer per concern", () => {
	// `call` wraps one call; `try` sequences a generator. One of each.
	for (const name of ["ok", "err", "call", "try", "all", "acquireRelease", "scoped"]) {
		expect(name in safe.Safe).toBe(true);
	}
	// No Effect-shaped constructors left.
	for (const name of [
		"promise",
		"succeed",
		"fail",
		"sync",
		"tryPromise",
		"fromResult",
		"addFinalizer",
	]) {
		expect(name in safe.Safe).toBe(false);
	}
	// Combinators the generator already provides.
	for (const name of ["map", "andThen"]) {
		expect(name in safe.Safe.prototype).toBe(false);
	}
	expect("catchTag" in safe.Safe.prototype).toBe(true);
});
