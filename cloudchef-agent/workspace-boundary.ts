/**
 * The two things a workspace shell command must never do: touch CloudChef's own platform processes
 * and state, or handle a Cloudflare credential (`cf auth`, which would sign `cf` in past the proxy that
 * holds the account's authorization). Everything else runs as asked; per-tool time limits
 * stop a command that does not finish.
 */

const PLATFORM_PROCESS_NAMES = new Set(['workerd', 'computerd']);

/** Build-tool state directories the model's file commands must not touch. */
const PLATFORM_STATE_DIRECTORIES = ['.wrangler', '.cloudflare'];

const FILE_MUTATION_COMMANDS = new Set(['rm', 'rmdir', 'mv', 'chmod', 'chown', 'truncate', 'shred', 'ln']);

const PLATFORM_STATE_REJECTION =
  `Rejected: platform runtime state (${PLATFORM_STATE_DIRECTORIES.join(', ')}, workerd, computerd) is managed by ` +
  'CloudChef and must not be modified.';

const CF_CREDENTIAL_REJECTION =
  "Rejected: cf needs no sign-in here. CloudChef adds the account's authorization outside the container, so " +
  "run the cf command itself; a change waits for the person's approval.";

const RUNNER_COMMANDS = new Set(['pnpm', 'npm', 'yarn', 'bun']);

const RUNNER_PASSTHROUGH_COMMANDS = new Set(['npx', 'pnpx', 'bunx']);

/** Wrapper words that defer to the command that follows them. */
const TRANSPARENT_WRAPPERS = new Set(['command', 'exec', 'env', 'time', 'sudo', 'nohup', 'setsid']);

/** Why a workspace shell command must not run, or null when it may. A heuristic over shell syntax, not a sandbox. */
export function rejectedWorkspaceCommand(command: string): string | null {
  for (const words of shellSegments(command)) {
    const rejection = rejectedSegment(words);
    if (rejection) {
      return rejection;
    }
  }
  return null;
}

function rejectedSegment(segment: string[]): string | null {
  const words = effectiveWords(segment);
  if (words.length === 0) {
    return null;
  }
  const base = baseName(words[0]!);
  const args = words.slice(1);

  if (words.some((word) => PLATFORM_PROCESS_NAMES.has(baseName(word)))) {
    return PLATFORM_STATE_REJECTION;
  }
  if (
    FILE_MUTATION_COMMANDS.has(base) &&
    args.some((argument) => PLATFORM_STATE_DIRECTORIES.some((directory) => argument.includes(directory)))
  ) {
    return PLATFORM_STATE_REJECTION;
  }
  if (base === 'cf' && args.includes('auth')) {
    return CF_CREDENTIAL_REJECTION;
  }
  const delegated = delegatedCommand(base, args);
  return delegated.length > 0 ? rejectedSegment(delegated) : null;
}

/** Words a runner hands to another executable (`pnpm exec cf`, `npx cf`), for re-classification. */
function delegatedCommand(base: string, args: string[]): string[] {
  if (RUNNER_PASSTHROUGH_COMMANDS.has(base)) {
    return args.filter((argument) => !argument.startsWith('-'));
  }
  if (RUNNER_COMMANDS.has(base) && (args[0] === 'exec' || args[0] === 'dlx')) {
    return args.slice(1);
  }
  return [];
}

/** Strip environment assignments, transparent wrappers, and quotes so the executable word leads. */
function effectiveWords(words: string[]): string[] {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || TRANSPARENT_WRAPPERS.has(baseName(word))) {
      index += 1;
      continue;
    }
    if (baseName(word) === 'timeout') {
      // Skip the utility, its flags, and its duration argument.
      index += 1;
      while (index < words.length && words[index]!.startsWith('-')) {
        index += 1;
      }
      index += 1;
      continue;
    }
    break;
  }
  return words.slice(index);
}

function baseName(word: string): string {
  const unquoted = word.replace(/^['"]|['"]$/g, '');
  return unquoted.slice(unquoted.lastIndexOf('/') + 1).toLowerCase();
}

/** The words of each command a shell line runs, split on `&&`, `||`, `;`, `|`, `&`, and newlines. */
function shellSegments(command: string): string[][] {
  // Redirection operators such as `2>&1` and `&>log` carry no control flow.
  return command
    .replace(/\d*>&\d*|&>>?/g, ' ')
    .split(/\|\||&&|[;|\n&]/)
    .map((segment) =>
      segment
        .trim()
        .split(/\s+/)
        .filter((word) => word.length > 0),
    );
}
