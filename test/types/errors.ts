import {
	type Arm,
	type CodeOf,
	defineErrors,
	type ErrorsOf,
	type Payload,
} from "../../src/errors.ts";
import { Pipe } from "../../src/index.ts";
import { Safe } from "../../src/safe.ts";
import { assertType, type Equal } from "./assert.ts";

const fsError = defineErrors({
	not_found: (path: string) => ({ message: "missing", path }),
	denied: (path: string, cause: unknown) => ({ message: "denied", path, cause }),
});
type FsError = ErrorsOf<typeof fsError>;

// An arm is the factory's own payload wrapped under its key — no added field.
type NotF = ReturnType<typeof fsError.not_found>;
assertType<Equal<NotF, { readonly not_found: { message: string; path: string } }>>();

type Denied = Arm<FsError, "denied">;
assertType<Equal<Denied, { readonly denied: { message: string; path: string; cause: unknown } }>>();

// The tag is the key, and the payload is exactly what the factory returned.
assertType<Equal<CodeOf<FsError>, "not_found" | "denied">>();
assertType<Equal<Payload<FsError, "not_found">, { message: string; path: string }>>();

// The union a caller reads: two single-key arms, no machinery to resolve.
assertType<
	Equal<
		FsError,
		| { readonly not_found: { message: string; path: string } }
		| { readonly denied: { message: string; path: string; cause: unknown } }
	>
>();

declare const read: Safe<string, FsError>;
const recovered = Safe.pipe(read, [
	Pipe.catchTag("not_found", (e: { message: string; path: string }) => {
		// The handler's argument is the factory's return type, not the arm.
		return Safe.ok(`default for ${e.path}`);
	}),
]);
assertType<Equal<typeof recovered, Safe<string, Arm<FsError, "denied">>>>();

const remapped = Safe.pipe(read, [Pipe.catchTag("denied", () => Safe.err("fatal" as const))]);
assertType<Equal<typeof remapped, Safe<string, Arm<FsError, "not_found"> | "fatal">>>();

// An unknown code compiles in pipe position and never matches.
Safe.pipe(read, [Pipe.catchTag("nope", () => Safe.ok(1))]);
