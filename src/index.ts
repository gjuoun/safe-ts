// safe-ts — public entry. Five values, three of them namespaces.
//
// One effect system: a lazy `Safe<A, E, R>`.
//   Safe:      run, ok, err, call, try, all, acquireRelease, scoped, catchTag
//   Services:  get, provide, instance, runtime
//   Errors:    define, render
//   Outcome, Scheduler: classes
import { defineErrors, renderError } from "./errors.ts";
import { makeRuntime } from "./runtime.ts";
import { get, instance, provide } from "./services.ts";

export const VERSION = "0.1.0";

/** Services: get one, provide classes, seed an instance, build a runtime. */
export const Services = { get, instance, provide, runtime: makeRuntime };

/** Error catalogs: define a set of variants, render one. */
export const Errors = { define: defineErrors, render: renderError };

export type {
	Arm,
	CodeOf,
	ErrorFactories,
	ErrorSpec,
	ErrorsOf,
	Payload,
	TaggedError,
} from "./errors.ts";
export { Outcome } from "./outcome.ts";
export type { Runtime } from "./runtime.ts";
export { type RunOptions, Safe } from "./safe.ts";
export { Scheduler } from "./scheduler.ts";
export type { Finalizer } from "./scope.ts";
export type {
	DepsOf,
	Entry,
	InitError,
	Instance,
	InstanceEntry,
	ServiceClass,
} from "./services.ts";
