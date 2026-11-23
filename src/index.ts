import pkg from "../package.json" with { type: "json" };
import { ops } from "./combinators.ts";
import { defineErrors, renderError } from "./errors.ts";
import { catchTag } from "./safe.ts";

export const VERSION: string = pkg.version;

export const Errors = { define: defineErrors, render: renderError };

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
