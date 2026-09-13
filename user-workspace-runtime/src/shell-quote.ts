/** Wrap a value in single quotes for /bin/sh, closing and re-opening around each embedded quote. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
