import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import * as safe from "../src/index.ts";

test("entry exports the namespaces and the pipe ops", () => {
	expect(safe.VERSION).toBe(pkg.version);
	for (const name of ["Outcome", "Runtime", "Safe", "Errors", "Policy", "Clocks"]) {
		expect(name in safe).toBe(true);
	}
	expect("Scheduler" in safe).toBe(false);

	for (const name of [
		"timeout",
		"retry",
		"defer",
		"scoped",
		"catchTag",
		"uninterruptible",
		"interruptible",
	]) {
		expect(name in safe.Pipe).toBe(true);
		expect(name in safe).toBe(false);
	}

	for (const name of ["defineErrors", "renderError", "makeRuntime", "get", "instance"]) {
		expect(name in safe).toBe(false);
	}

	expect("run" in safe.Safe).toBe(false);
	for (const name of ["run"]) {
		expect(name in safe.Runtime).toBe(true);
	}
	expect("make" in safe.Runtime).toBe(false);
	for (const name of ["define", "render"]) {
		expect(name in safe.Errors).toBe(true);
	}
	for (const name of [
		"forever",
		"spaced",
		"exponential",
		"min",
		"max",
		"while",
		"modifyDelay",
		"pipe",
	]) {
		expect(name in safe.Policy).toBe(true);
	}
	for (const name of ["real", "manual"]) {
		expect(name in safe.Clocks).toBe(true);
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
		"Exit",
		"Cause",
		"safeTry",
	]) {
		expect(name in safe).toBe(false);
	}
});

test("Safe exposes one answer per concern", () => {
	for (const name of [
		"ok",
		"err",
		"call",
		"try",
		"all",
		"allSettled",
		"race",
		"delay",
		"forEach",
		"pipe",
	]) {
		expect(name in safe.Safe).toBe(true);
	}

	for (const name of ["timeout", "retry", "scoped", "catchTag", "sleep"]) {
		expect(name in safe.Safe).toBe(false);
	}

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

	for (const name of ["map", "andThen", "catchTag"]) {
		expect(name in safe.Safe.prototype).toBe(false);
	}
});
