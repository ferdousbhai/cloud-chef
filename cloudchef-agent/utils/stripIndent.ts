/** A template literal with its common indentation, blank lines, and trailing spaces removed. */
export function stripIndents(strings: TemplateStringsArray, ...values: unknown[]): string {
  const value = strings.map((chunk, index) => `${chunk}${values[index] ?? ''}`).join('');
  const lines = value.split('\n');
  let minIndent = Infinity;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.length === 0) {
      continue;
    }
    minIndent = Math.min(minIndent, line.length - trimmed.length);
  }
  if (minIndent === Infinity) {
    return value;
  }
  return lines
    .map((line) => line.slice(minIndent).trimEnd())
    .filter((line) => line.length > 0)
    .join('\n')
    .replace(/[\r\n]$/, '');
}
