export function stripIndents(value: string): string;
export function stripIndents(strings: TemplateStringsArray, ...values: unknown[]): string;
export function stripIndents(arg0: string | TemplateStringsArray, ...values: unknown[]) {
  if (typeof arg0 !== 'string') {
    return _stripIndents(arg0.map((chunk, index) => `${chunk}${values[index] ?? ''}`).join(''));
  }

  return _stripIndents(arg0);
}

function _stripIndents(value: string) {
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
