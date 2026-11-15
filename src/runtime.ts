// runtime.ts — the one entry point.
//
// Without a service graph there is nothing to own: each `run` allocates its own
// Scope and signal, executes the Safe, and closes whatever the program opened
// before it settles. `run` never rejects — every way work can stop is an
// Outcome arm. Resources that outlive a request belong to the composition root
// (plain constructors, a plain dispose), not to the library.
import { run } from "./safe.ts";

export const Runtime = { run } as const;
