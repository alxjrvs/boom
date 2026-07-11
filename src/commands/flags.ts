// Shared flag/positional building blocks, so command modules stop re-declaring the same
// tiny parsers. Stricli's `parse` for a string flag is the identity function; spelling it
// out (`parse: (s: string) => s`) at ~10 call sites is noise — import `str` instead.
export const str = (s: string): string => s;
