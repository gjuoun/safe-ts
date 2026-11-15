// safe-ts — public entry.
//
// One effect system: a lazy `Safe<A, E, R>`.
//   boundaries: Safe.call               (a mapper makes the throw typed)
//   sequencing: Safe.try
//   services:   get, provide, instance, makeRuntime
//   errors:     defineErrors, renderError, Safe.catchTag
//   outcome:    Outcome
//   cleanup:    Safe.acquireRelease, Safe.scoped
export const VERSION = "0.1.0";

export { all } from "./all.ts";
export {
	type Arm,
	type CodeOf,
	defineErrors,
	type ErrorFactories,
	type ErrorSpec,
	type ErrorsOf,
	type Payload,
	renderError,
	type TaggedError,
} from "./errors.ts";
export { Outcome } from "./outcome.ts";
export { makeRuntime, type Runtime } from "./runtime.ts";
export { type RunOptions, run, Safe } from "./safe.ts";
export { Scheduler } from "./scheduler.ts";
export type { Finalizer } from "./scope.ts";
export {
	type DepsOf,
	type Entry,
	get,
	type InitError,
	type Instance,
	type InstanceEntry,
	instance,
	provide,
	type ServiceClass,
} from "./services.ts";
