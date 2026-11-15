import { expect, test } from "bun:test";
import * as safe from "../src/index.ts";

test("entry exports the namespaces and the pipe ops", () => {
	expect(safe.VERSION).toBe("0.1.0");
	for (const name of [
		"Outcome",
		"Runtime",
		"Safe",
		"Scheduler",
		"Services",
		"Errors",
		"Policy",
		"Clocks",
	]) {
		expect(name in safe).toBe(true);
	}
	// The pipe ops live in the Pipe namespace — assemble through pipe, not Safe.
	for (const name of [
		"timeout",
		"retry",
		"ensuring",
		"scoped",
		"acquireRelease",
		"catchTag",
		"provide",
		"uninterruptible",
		"interruptible",
	]) {
		expect(name in safe.Pipe).toBe(true);
		expect(name in safe).toBe(false);
	}
	// The loose construction names are gone: each question has one place to live.
	for (const name of ["defineErrors", "renderError", "makeRuntime", "get", "instance"]) {
		expect(name in safe).toBe(false);
	}
	// The executor lives on Runtime: one-shot, factory, instance run.
	expect("run" in safe.Safe).toBe(false);
	for (const name of ["run", "make"]) {
		expect(name in safe.Runtime).toBe(true);
	}
	for (const name of ["get", "provide", "new"]) {
		expect(name in safe.Services).toBe(true);
	}
	expect("runtime" in safe.Services).toBe(false);
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
	// Constructors create; everything else is a pipe op.
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
	// The wrappers left Safe for pipe: no second spelling.
	for (const name of [
		"timeout",
		"retry",
		"ensuring",
		"scoped",
		"acquireRelease",
		"catchTag",
		"sleep",
	]) {
		expect(name in safe.Safe).toBe(false);
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
	for (const name of ["map", "andThen", "catchTag"]) {
		expect(name in safe.Safe.prototype).toBe(false);
	}
});
