// safe-ts — public entry.
//
// One effect system: a lazy `Safe<A, E>`. Constructors create it; `pipe`
// folds the `Safe → Safe` ops over it; `Policy.*` names build the policy
// `retry` consumes; `Runtime.run` executes it.
//   Safe:      ok, err, call, try, defer, all, allSettled, race, delay, forEach, pipe
//   Pipe:      timeout, retry, defer, scoped, catchTag, uninterruptible,
//              interruptible — the Safe → Safe ops
//   Errors:    define, render
//   Policy:    forever, spaced, exponential, min, max, while, modifyDelay, pipe
//   Clocks:    real, manual
//   Runtime:   run — the one entry point
//   Outcome: value and type; Scheduler: callback interface
import { ops } from "./combinators.ts";
import { defineErrors, renderError } from "./errors.ts";
import { catchTag } from "./safe.ts";

export const VERSION = "0.1.0";

/** Error catalogs: define a set of variants, render one. */
export const Errors = { define: defineErrors, render: renderError };

/**
 * The pipe ops: every `Safe → Safe` the library ships, in one namespace —
 * `Safe.pipe(fetch, Pipe.timeout(2_000), Pipe.retry(policy))`. `catchTag` joins
 * them here because it is a `Safe → Safe` factory too.
 */
export const Pipe = { catchTag, ...ops } as const;

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
	FailureOf,
	Payload,
	TaggedError,
} from "./errors.ts";
export { Outcome } from "./outcome.ts";
export { Policy, type PolicyOp, type PolicyState } from "./policy.ts";
export { Runtime } from "./runtime.ts";
export { type RunOptions, Safe, type SafeOp } from "./safe.ts";
export type { Scheduler } from "./scheduler.ts";
export type { Finalizer } from "./scope.ts";
