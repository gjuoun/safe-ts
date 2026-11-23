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

type NotF = ReturnType<typeof fsError.not_found>;
assertType<Equal<NotF, { readonly not_found: { message: string; path: string } }>>();

type Denied = Arm<FsError, "denied">;
assertType<Equal<Denied, { readonly denied: { message: string; path: string; cause: unknown } }>>();

assertType<Equal<CodeOf<FsError>, "not_found" | "denied">>();
assertType<Equal<Payload<FsError, "not_found">, { message: string; path: string }>>();

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
		return Safe.ok(`default for ${e.path}`);
	}),
]);
assertType<Equal<typeof recovered, Safe<string, Arm<FsError, "denied">>>>();

const remapped = Safe.pipe(read, [Pipe.catchTag("denied", () => Safe.err("fatal" as const))]);
assertType<Equal<typeof remapped, Safe<string, Arm<FsError, "not_found"> | "fatal">>>();

Safe.pipe(read, [Pipe.catchTag("nope", () => Safe.ok(1))]);
