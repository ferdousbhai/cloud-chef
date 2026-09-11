/**
 * Programmatic builder/platform boundary for the generated-project workspace.
 *
 * Tool descriptions already tell the model not to run servers or repair platform
 * state, but description text is advisory: a confused model still burns many
 * minutes "fixing" infrastructure it does not own. These classifiers reject the
 * command or file mutation before it executes, with a concise error that points
 * the model back at productive work.
 */

import { WORK_DIR } from './constants.js';
import { path } from './utils/path.js';
import { getAbsolutePath } from './utils/workDir.js';

const SERVER_REJECTION =
  'Rejected: long-running servers are not available in this workspace. Ghostbuild publishes the hosted preview ' +
  'automatically after validation. Finish the change, then validate the project.';

const PROCESS_REJECTION =
  'Rejected: process management is handled by the Ghostbuild platform. Do not kill or signal processes; if a ' +
  'command appears stuck, stop and report the failure instead.';

const PLATFORM_STATE_REJECTION =
  'Rejected: platform runtime state (.wrangler, workerd, computerd) is managed by Ghostbuild and must not be ' +
  'modified. Work only on project source files.';

const REQUIRED_BINDING_REJECTION =
  'Rejected: wrangler.jsonc must keep the required DB, APP_STORAGE, and APP_CACHE bindings. Ghostbuild provisions ' +
  'these Cloudflare resources for every generated app; removing a binding breaks validation and deployment.';

/** Every binding Ghostbuild provisions, as it appears in the generated wrangler config. */
const REQUIRED_BINDING_PATTERNS = ['DB', 'APP_STORAGE', 'APP_CACHE'].map(
  (binding) => new RegExp(`"binding"\\s*:\\s*"${binding}"`),
);

/** Script names that start a dev, preview, or watch server when run through a package runner. */
const SERVER_SCRIPT_NAMES = new Set(['dev', 'develop', 'preview', 'serve', 'start', 'watch']);

/** Commands that exist to run a long-lived server. */
const SERVER_COMMANDS = new Set([
  'browser-sync',
  'http-server',
  'json-server',
  'live-server',
  'nodemon',
  'serve',
  'webpack-dev-server',
]);

/** Subcommands that turn an otherwise finite CLI into a long-lived server or stream. */
const SERVER_SUBCOMMANDS = new Map<string, ReadonlySet<string>>([
  ['astro', new Set(['dev', 'preview'])],
  ['next', new Set(['dev', 'start'])],
  ['nuxt', new Set(['dev', 'preview', 'start'])],
  ['remix', new Set(['dev'])],
  ['vite', new Set(['dev', 'preview', 'serve'])],
  ['webpack', new Set(['serve', 'watch'])],
  ['wrangler', new Set(['dev', 'tail'])],
]);

const PROCESS_COMMANDS = new Set(['kill', 'pkill', 'killall', 'fuser']);

const PLATFORM_PROCESS_NAMES = new Set(['workerd', 'computerd']);

const FILE_MUTATION_COMMANDS = new Set(['rm', 'rmdir', 'mv', 'chmod', 'chown', 'truncate', 'shred', 'ln']);

const DETACH_COMMANDS = new Set(['nohup', 'setsid', 'disown']);

const RUNNER_COMMANDS = new Set(['pnpm', 'npm', 'yarn', 'bun']);

const RUNNER_PASSTHROUGH_COMMANDS = new Set(['npx', 'pnpx', 'bunx']);

/** Wrapper words that defer to the command that follows them. */
const TRANSPARENT_WRAPPERS = new Set(['command', 'exec', 'env', 'time', 'sudo']);

/** Operators that end a command segment; `&` additionally backgrounds the segment it ends. */
const SEGMENT_SEPARATORS = new Set(['&&', '||', ';', '|', '\n', '&']);

type CommandSegment = { words: string[]; background: boolean };

/**
 * Why a workspace shell command must not run, or null when it may. The check is a heuristic over
 * shell syntax, not a sandbox: validation and deployment still enforce correctness afterwards. It
 * exists so the model gets an immediate, explanatory refusal instead of a broken workspace.
 */
export function rejectedWorkspaceCommand(command: string): string | null {
  for (const segment of shellSegments(command)) {
    const rejection = rejectedSegment(segment);
    if (rejection) {
      return rejection;
    }
  }
  return null;
}

/**
 * Why a model write/edit of this project file must not apply, or null when it may.
 *
 * The path is canonicalized first because every layer below this one canonicalizes too: the
 * workspace runtime folds `\` to `/` and collapses repeated slashes, and Computer drops `.`
 * segments before the write lands. A raw string compare would let `/home/project/./wrangler.jsonc`
 * past the guard and onto the real config, dropping the bindings this exists to protect.
 */
export function rejectedWorkspaceFileMutation(pathString: string, content: string): string | null {
  if (path.normalize(getAbsolutePath(pathString.replaceAll('\\', '/'))) !== `${WORK_DIR}/wrangler.jsonc`) {
    return null;
  }
  return REQUIRED_BINDING_PATTERNS.every((pattern) => pattern.test(content)) ? null : REQUIRED_BINDING_REJECTION;
}

function rejectedSegment(segment: CommandSegment): string | null {
  const words = effectiveWords(segment.words);
  if (words.length === 0) {
    return null;
  }
  const base = baseName(words[0]!);
  const args = words.slice(1);

  if (DETACH_COMMANDS.has(base)) {
    return SERVER_REJECTION;
  }
  if (PROCESS_COMMANDS.has(base)) {
    return PROCESS_REJECTION;
  }
  if (words.some((word) => PLATFORM_PROCESS_NAMES.has(baseName(word)))) {
    return PLATFORM_STATE_REJECTION;
  }
  if (FILE_MUTATION_COMMANDS.has(base) && args.some((argument) => argument.includes('.wrangler'))) {
    return PLATFORM_STATE_REJECTION;
  }

  if (segment.background) {
    return SERVER_REJECTION;
  }
  if (SERVER_COMMANDS.has(base)) {
    return SERVER_REJECTION;
  }
  const subcommands = SERVER_SUBCOMMANDS.get(base);
  if (subcommands) {
    const subcommand = args.find((argument) => !argument.startsWith('-'));
    // A bare `vite` starts the dev server; every other listed CLI is finite without a subcommand.
    if (subcommand === undefined ? base === 'vite' : subcommands.has(subcommand)) {
      return SERVER_REJECTION;
    }
  }
  if (args.includes('--watch') || (base === 'tsc' && args.includes('-w'))) {
    return SERVER_REJECTION;
  }
  if (base === 'tail' && args.some((argument) => argument === '-f' || argument === '-F')) {
    return SERVER_REJECTION;
  }

  const runnerScript = runnerScriptName(base, args);
  if (
    runnerScript !== null &&
    (SERVER_SCRIPT_NAMES.has(runnerScript) || runnerScript.includes('watch') || runnerScript.startsWith('dev:'))
  ) {
    return SERVER_REJECTION;
  }
  const delegated = delegatedCommand(base, args);
  if (delegated.length > 0) {
    return rejectedSegment({ words: delegated, background: false });
  }
  return null;
}

/** The package script a runner invocation names, or null when it is not a script invocation. */
function runnerScriptName(base: string, args: string[]): string | null {
  if (!RUNNER_COMMANDS.has(base)) {
    return null;
  }
  const positional = args.filter((argument) => !argument.startsWith('-'));
  const first = positional[0];
  if (first === undefined) {
    return null;
  }
  if (first === 'run' || first === 'run-script') {
    return positional[1] ?? null;
  }
  // `pnpm dev` and friends run the script directly, without `run`.
  return first;
}

/** Words a runner hands to another executable (`pnpm exec vite`, `npx serve`), for re-classification. */
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
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1;
      continue;
    }
    if (TRANSPARENT_WRAPPERS.has(baseName(word))) {
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

function shellSegments(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let current = '';
  const push = (background: boolean) => {
    const words = current
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0);
    segments.push({ words, background });
    current = '';
  };
  // Redirection operators such as `2>&1` and `&>log` carry no control flow; without this they
  // would read as background `&` separators.
  const parts = command.replace(/\d*>&\d*|&>>?/g, ' ').split(/(\|\||&&|[;|\n&])/);
  for (const part of parts) {
    if (SEGMENT_SEPARATORS.has(part)) {
      push(part === '&');
    } else {
      current += part;
    }
  }
  push(false);
  return segments;
}
