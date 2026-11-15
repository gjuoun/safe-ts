// errors.ts — thiserror-style error catalogs.
//
// `defineErrors` takes one factory per variant (message and fields co-located,
// like a `#[derive(Error)]` enum) and wraps the factory's own payload under the
// object key: `not_found("/a")` is `{ not_found: { message, path } }`. The
// library adds no field of its own — a `message` exists only because the
// factory declared one, and `cause` is the analogue of thiserror's `#[source]`.
// The key is the tag, so a variant is narrowed by `"key" in error`.
export type ErrorSpec = (...args: never[]) => object;

export type ErrorFactories<M extends Record<string, ErrorSpec>> = {
	[K in keyof M & string]: (...args: Parameters<M[K]>) => {
		readonly [P in K]: ReturnType<M[K]>;
	};
};

export const defineErrors = <M extends Record<string, ErrorSpec>>(map: M): ErrorFactories<M> =>
	// Generic-position cast: TS can't correlate the string key with K here.
	Object.fromEntries(
		Object.entries(map).map(([code, factory]) => [
			code,
			(...args: never[]) => ({ [code]: factory(...args) }),
		]),
	) as unknown as ErrorFactories<M>;

/** The error union a catalog produces: `ErrorsOf<typeof readError>`. */
export type ErrorsOf<F extends Record<string, (...args: never[]) => unknown>> = ReturnType<
	F[keyof F]
>;

/**
 * One variant of a catalog, named by its tag: `FailureOf<typeof userError, "not_found">`.
 * The same type as `ReturnType<typeof userError.not_found>`. Name it once beside the
 * catalog, then a signature can say `Safe<A, NotFound | Conflict>` instead of carrying
 * the whole union — the tag is in the name, not in a second wrapper.
 */
export type FailureOf<
	C extends Record<string, (...args: never[]) => object>,
	K extends keyof C & string,
> = ReturnType<C[K]>;

/** The tag of each arm, inferred from its single key. */
export type CodeOf<E> = E extends Record<infer C extends string, unknown> ? C : never;

/** The arm carrying one tag — the single-key object itself. */
export type Arm<E, K extends string> = Extract<E, Record<K, unknown>>;

/** The payload under one tag: exactly what the factory returned. */
export type Payload<E, K extends string> = Arm<E, K> extends Record<K, infer P> ? P : never;

/** Any catalog error: one key naming the variant, its value the payload. */
export interface TaggedError {
	readonly [code: string]: unknown;
}

/** Read `message` off a payload that may not have declared one. */
const payloadMessage = (payload: unknown): string | undefined =>
	typeof payload === "object" &&
	payload !== null &&
	"message" in payload &&
	typeof payload.message === "string"
		? payload.message
		: undefined;

/** Read `cause` off a payload that may not have declared one. */
const payloadCause = (payload: unknown): unknown =>
	typeof payload === "object" && payload !== null && "cause" in payload ? payload.cause : undefined;

const causeText = (cause: unknown): string =>
	cause instanceof Error
		? cause.message
		: typeof cause === "object" && cause !== null && "message" in cause
			? String(cause.message)
			: String(cause);

/**
 * Default renderer: the key is the code, so `error: <code>\n\n<message>`, plus
 * a `caused by:` line when the payload carries a cause. Total: a payload with
 * no `message` prints `error: <code>` alone. Catalogs with their own text
 * contract keep their own renderer.
 */
export const renderError = (e: TaggedError): string => {
	const [code = "unknown"] = Object.keys(e);
	const message = payloadMessage(e[code]);
	const cause = payloadCause(e[code]);
	const base = message === undefined ? `error: ${code}` : `error: ${code}\n\n${message}`;
	return cause === undefined ? base : `${base}\ncaused by: ${causeText(cause)}`;
};
