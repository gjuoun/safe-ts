// safe-ts — public entry.
//
// One effect system: a lazy `Safe<A, E, R>`. Constructors create it; `pipe`
// folds the `Safe → Safe` ops over it; `Policy.*` names build the policy
// `retry` consumes; `Runtime.run` executes it.
//   Safe:      ok, err, call, try, all, allSettled, race, delay, forEach, pipe
//   Pipe:      timeout, retry, ensuring, scoped, acquireRelease, catchTag,
//              provide, uninterruptible, interruptible — the Safe → Safe ops
//   Services:  get, provide, new
//   Errors:    define, render
//   Policy:    forever, spaced, exponential, min, max, while, modifyDelay, pipe
//   Clocks:    real, manual
//   Runtime:   run (one-shot), make (owning), instance run/dispose
//   Outcome, Scheduler: classes
import { ops } from "./combinators.ts";
import { defineErrors, renderError } from "./errors.ts";
import { catchTag } from "./safe.ts";
import { get, instance, provide } from "./services.ts";

export const VERSION = "0.1.0";

/** Services: get one, provide classes, seed a ready instance. */
export const Services = { get, new: instance, provide };

/** Error catalogs: define a set of variants, render one. */
export const Errors = { define: defineErrors, render: renderError };

/**
 * The pipe ops: every `Safe → Safe` the library ships, in one namespace —
 * `Safe.pipe(fetch, [Pipe.timeout(2_000), Pipe.retry(policy)])`. `provide` and
 * `catchTag` join them at this level: `Services.provide` is the run-boundary
 * spelling of the same idea.
 */
export const Pipe = { catchTag, provide, ...ops } as const;

export type { AllSettledA } from "./all.ts";
export { type Clock, Clocks } from "./clock.ts";
export {
	delay,
	type ForEachOptions,
	forEach,
	type RaceOptions,
	type RetryOptions,
	race,
	TIMEOUT,
} from "./combinators.ts";
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
export { Policy, type PolicyOp, type PolicyState } from "./policy.ts";
export { Runtime } from "./runtime.ts";
export { type RunOptions, Safe, type SafeOp } from "./safe.ts";
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
