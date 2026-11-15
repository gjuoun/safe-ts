// Type-level assertion helpers. Files under test/types/ are checked by `tsc` only.
export type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

export const assertType = <_T extends true>(): void => {};
