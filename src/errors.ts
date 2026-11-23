export type ErrorSpec = (...args: never[]) => object;

export type ErrorFactories<M extends Record<string, ErrorSpec>> = {
	[K in keyof M & string]: (...args: Parameters<M[K]>) => {
		readonly [P in K]: ReturnType<M[K]>;
	};
};

export const defineErrors = <M extends Record<string, ErrorSpec>>(map: M): ErrorFactories<M> =>
	Object.fromEntries(
		Object.entries(map).map(([code, factory]) => [
			code,
			(...args: never[]) => ({ [code]: factory(...args) }),
		]),
	) as unknown as ErrorFactories<M>;

export type ErrorsOf<F extends Record<string, (...args: never[]) => unknown>> = ReturnType<
	F[keyof F]
>;

export type FailureOf<
	C extends Record<string, (...args: never[]) => object>,
	K extends keyof C & string,
> = ReturnType<C[K]>;

export type CodeOf<E> = E extends Record<infer C extends string, unknown> ? C : never;

export type Arm<E, K extends string> = Extract<E, Record<K, unknown>>;

export type Payload<E, K extends string> = Arm<E, K> extends Record<K, infer P> ? P : never;

export interface TaggedError {
	readonly [code: string]: unknown;
}

const payloadMessage = (payload: unknown): string | undefined =>
	typeof payload === "object" &&
	payload !== null &&
	"message" in payload &&
	typeof payload.message === "string"
		? payload.message
		: undefined;

const payloadCause = (payload: unknown): unknown =>
	typeof payload === "object" && payload !== null && "cause" in payload ? payload.cause : undefined;

const causeText = (cause: unknown): string =>
	cause instanceof Error
		? cause.message
		: typeof cause === "object" && cause !== null && "message" in cause
			? String(cause.message)
			: String(cause);

export const renderError = (e: TaggedError): string => {
	const [code = "unknown"] = Object.keys(e);
	const message = payloadMessage(e[code]);
	const cause = payloadCause(e[code]);
	const base = message === undefined ? `error: ${code}` : `error: ${code}\n\n${message}`;
	return cause === undefined ? base : `${base}\ncaused by: ${causeText(cause)}`;
};
