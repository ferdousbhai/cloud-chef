import { MAX_EPHEMERAL_CONTEXT_CHARACTERS } from 'cloudchef-agent/context-limits';

export function workspaceHintsToTurnContext(
  {
    currentFile,
    changedFiles,
  }: {
    currentFile?: string;
    changedFiles?: readonly string[];
  },
  maximumCharacters = MAX_EPHEMERAL_CONTEXT_CHARACTERS,
): string {
  const limit = Math.max(0, Math.trunc(maximumCharacters));
  const changed = [...new Set(changedFiles ?? [])].sort();
  const lines: string[] = [];

  if (currentFile) {
    lines.push(`Current editor file: ${JSON.stringify(currentFile)}`);
  }
  if (changed.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('User-modified durable workspace files; read relevant files before editing:');
    for (const [index, filePath] of changed.entries()) {
      const line = `- ${JSON.stringify(filePath)}`;
      const omitted = changed.length - index - 1;
      const suffix = omitted > 0 ? `- ... ${omitted} more modified files; use workspace discovery to inspect them` : '';
      const candidate = [...lines, line, ...(suffix ? [suffix] : [])].join('\n');
      if (candidate.length > limit) {
        const remaining = changed.length - index;
        const omittedLine = `- ... ${remaining} more modified files; use workspace discovery to inspect them`;
        if ([...lines, omittedLine].join('\n').length <= limit) {
          lines.push(omittedLine);
        }
        break;
      }
      lines.push(line);
    }
  }

  const context = lines.join('\n');
  return context.length <= limit ? context : '';
}
