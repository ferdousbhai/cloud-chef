import { COMPUTER_TOOL_LIMITS } from '../../cloudchef-agent/cloudflare-computer';
import { logicalLines } from '../../cloudchef-agent/line-edit';

/**
 * Project discovery answered from the Durable Object's SQLite VFS.
 *
 * Everything here reads the same authoritative store `read` reads and touches nothing else: no
 * container, no shell process, no filesystem sync barrier, no exclusive workspace operation lane.
 * That is the point of the module — "what files exist" and "where is this symbol" used to cost a
 * container wake plus a durable sync round trip through `exec`, and the VFS can answer both
 * before the container is warm and while a build command holds the lane.
 */

/**
 * The Computer filesystem surface discovery uses, named structurally so these functions can be
 * exercised against a plain fake instead of a Durable Object.
 */
export type DiscoveryFilesystem = {
  readdir(path: string): Promise<ReadonlyArray<{ name: string; isFile: boolean; isDirectory: boolean }>>;
  stat(path: string): Promise<{ size: number; isFile: boolean }>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
};

/**
 * Model-visible output ceiling shared by both discovery tools.
 *
 * A listing and a search result are generated streams, not a file the model named, so they are
 * bounded like exec output rather than like a read: the model can always narrow the prefix or the
 * pattern and ask again, it is told when the result was cut, and no byte is reachable only through
 * these tools.
 */
export const DISCOVERY_MAX_OUTPUT_BYTES = COMPUTER_TOOL_LIMITS.execMaxBytesPerStream;

/**
 * Entries per listing. A listing is navigation rather than content: a directory needing more than
 * a thousand paths to describe itself needs a narrower prefix, and spending the context window on
 * paths starves the reads that have to follow. The model is told when the listing was cut.
 */
export const DISCOVERY_MAX_LIST_ENTRIES = 1_000;

/**
 * Matches per search. A search returning more than this has a pattern too broad to act on; the
 * model gets the ceiling flag and narrows the pattern instead of paging through noise.
 */
export const DISCOVERY_MAX_MATCHES = 100;

/**
 * Characters kept from one matching line — enough to read a real statement in context, not just
 * identify it. It exists only because generated and minified sources hold single lines long enough
 * to consume the whole output budget on one hit; the shared byte ceiling, not this, is what bounds
 * a search overall.
 */
export const DISCOVERY_MAX_MATCH_TEXT_CHARS = 960;

/**
 * Per-file and whole-call ceilings on bytes decoded during one search.
 *
 * A Durable Object serves this on the same thread as every other request to the project, so an
 * unbounded scan of a workspace holding up to 64 MiB would stall all of them. A file larger than
 * one full `read` page is a bundle or a lockfile rather than something worth grepping, and the
 * whole-call ceiling stops a pattern that matches nothing from decoding the entire workspace.
 */
export const DISCOVERY_MAX_SEARCH_FILE_BYTES = COMPUTER_TOOL_LIMITS.readMaxBytes;
const DISCOVERY_MAX_SEARCH_TOTAL_BYTES = 8 * 1024 * 1024;

/** Files one search may open, bounding SQLite work even when every file is small. */
export const DISCOVERY_MAX_SEARCH_FILES = 1_000;

/**
 * Directory entries one call may walk past, and how deep it may descend.
 *
 * These are the guards that hold when the filters do not: a symlink cycle in the VFS would
 * otherwise make the walk non-terminating, and a project that installed something enormous
 * outside the pruned roots would otherwise make it merely unbounded.
 */
const DISCOVERY_MAX_TRAVERSAL_ENTRIES = 20_000;
export const DISCOVERY_MAX_TRAVERSAL_DEPTH = 32;

/** Longest accepted search pattern: long enough for a full import specifier, short enough that the needle cannot be the payload. */
export const DISCOVERY_MAX_PATTERN_CHARS = 200;

type ProjectEntry = { path: string; type: 'file' | 'dir' };

type ProjectListing = {
  path: string;
  recursive: boolean;
  entries: ProjectEntry[];
  entryCount: number;
  truncated: boolean;
};

type ProjectSearchMatch = { path: string; line: number; text: string };

type ProjectSearchResult = {
  pattern: string;
  path: string;
  matches: ProjectSearchMatch[];
  matchCount: number;
  filesScanned: number;
  filesSkipped: number;
  truncated: boolean;
};

type ProjectListingOptions = { recursive: boolean; limit: number };

type ProjectSearchOptions = { pattern: string; ignoreCase: boolean; limit: number };

export type DiscoveryScope = {
  /** Directory the caller asked about, already resolved to an absolute path inside the project. */
  path: string;
  /** Project root, which decides which generated top-level directories a walk refuses to descend into. */
  root: string;
  /** Names of those directories, relative to the root. */
  prunedRoots: ReadonlySet<string>;
};

/** Validate the non-path listing arguments; the caller resolves the path because it owns the project-root rule. */
export function requireProjectListingOptions(value: unknown): ProjectListingOptions {
  const request = requireRecord(value);
  return {
    recursive: requireOptionalBoolean(request.recursive, 'recursive') ?? false,
    limit: requireBoundedCount(request.limit, 'limit', DISCOVERY_MAX_LIST_ENTRIES),
  };
}

/** Validate the non-path search arguments, including the untrusted pattern. */
export function requireProjectSearchOptions(value: unknown): ProjectSearchOptions {
  const request = requireRecord(value);
  const pattern = request.pattern;
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > DISCOVERY_MAX_PATTERN_CHARS) {
    throw new SyntaxError(`Search pattern must be 1 to ${DISCOVERY_MAX_PATTERN_CHARS} characters.`);
  }
  // Matching is per line, so a needle containing a line break could never match. Saying so beats
  // an empty result the model would read as "this symbol does not exist".
  if (/[\r\n]/.test(pattern)) {
    throw new SyntaxError('Search pattern must be a single line.');
  }
  return {
    pattern,
    ignoreCase: requireOptionalBoolean(request.ignoreCase, 'ignoreCase') ?? false,
    limit: requireBoundedCount(request.limit, 'limit', DISCOVERY_MAX_MATCHES),
  };
}

/** Enumerate one directory, or the tree beneath it, straight from the VFS. */
export async function enumerateProjectEntries(
  fs: DiscoveryFilesystem,
  scope: DiscoveryScope,
  options: ProjectListingOptions,
): Promise<ProjectListing> {
  const walk = walkProject(fs, scope, options.recursive);
  const entries: ProjectEntry[] = [];
  let bytes = 0;
  let truncated = false;
  for await (const entry of walk.entries) {
    const entryBytes = utf8Length(entry.path) + entry.type.length;
    if (entries.length >= options.limit || bytes + entryBytes > DISCOVERY_MAX_OUTPUT_BYTES) {
      truncated = true;
      break;
    }
    entries.push(entry);
    bytes += entryBytes;
  }
  return {
    path: scope.path,
    recursive: options.recursive,
    entries,
    entryCount: entries.length,
    truncated: truncated || walk.stopped(),
  };
}

/**
 * Find lines containing a literal pattern across project files.
 *
 * The pattern is untrusted model input and reaches exactly one place: the needle of
 * `String.includes`. It is never compiled into a regular expression, where a crafted pattern
 * could backtrack catastrophically and wedge the Durable Object's only thread, and never
 * concatenated into a shell command, where it would be an injection into the container.
 */
export async function scanProjectFiles(
  fs: DiscoveryFilesystem,
  scope: DiscoveryScope,
  options: ProjectSearchOptions,
): Promise<ProjectSearchResult> {
  const needle = options.ignoreCase ? options.pattern.toLowerCase() : options.pattern;
  const walk = walkProject(fs, scope, true);
  const matches: ProjectSearchMatch[] = [];
  let filesOpened = 0;
  let filesScanned = 0;
  let filesSkipped = 0;
  let scannedBytes = 0;
  let outputBytes = 0;
  let truncated = false;

  files: for await (const entry of walk.entries) {
    if (entry.type !== 'file') {
      continue;
    }
    if (
      matches.length >= options.limit ||
      filesOpened >= DISCOVERY_MAX_SEARCH_FILES ||
      scannedBytes >= DISCOVERY_MAX_SEARCH_TOTAL_BYTES
    ) {
      truncated = true;
      break;
    }
    filesOpened += 1;

    const size = await fileSize(fs, entry.path);
    if (size === null || size > DISCOVERY_MAX_SEARCH_FILE_BYTES) {
      filesSkipped += 1;
      continue;
    }
    const content = await readFileOrNull(fs, entry.path);
    if (content === null) {
      filesSkipped += 1;
      continue;
    }
    // A decoded NUL is the signature of a binary blob the lenient utf8 decoder replaced rather
    // than rejected. Scanning it burns the byte budget and returns unreadable "lines".
    if (content.includes('\0')) {
      filesSkipped += 1;
      continue;
    }
    filesScanned += 1;
    scannedBytes += size;

    // Line numbers come from the same splitter `read` and `edit` use, so a hit here names the
    // line an edit would change.
    const lines = logicalLines(content);
    for (const [index, line] of lines.entries()) {
      if (matches.length >= options.limit) {
        truncated = true;
        break;
      }
      const haystack = options.ignoreCase ? line.toLowerCase() : line;
      if (!haystack.includes(needle)) {
        continue;
      }
      const text = truncateMatchText(line);
      const matchBytes = utf8Length(entry.path) + utf8Length(text);
      if (outputBytes + matchBytes > DISCOVERY_MAX_OUTPUT_BYTES) {
        truncated = true;
        break files;
      }
      matches.push({ path: entry.path, line: index + 1, text });
      outputBytes += matchBytes;
    }
  }

  return {
    pattern: options.pattern,
    path: scope.path,
    matches,
    matchCount: matches.length,
    filesScanned,
    filesSkipped,
    truncated: truncated || walk.stopped(),
  };
}

type ProjectWalk = {
  /** Depth-first, name-ordered: a directory is yielded before its contents. */
  entries: AsyncGenerator<ProjectEntry>;
  /** Whether a traversal guard cut the walk short rather than the consumer's own bound. */
  stopped: () => boolean;
};

/**
 * Walk the VFS lazily so a consumer that stops early never pays for the rest of the tree.
 *
 * Generated directories are yielded but never descended into. Pruning descent rather than
 * display keeps the listing honest about what is on disk while keeping a tree walk from
 * exhausting its entry bound inside `node_modules` before it reaches any project source. Naming
 * one of those directories as the scope turns pruning off: the model reading inside an installed
 * package has already scoped the work, and that is how it reads the framework version the
 * project actually builds against.
 */
function walkProject(fs: DiscoveryFilesystem, scope: DiscoveryScope, recursive: boolean): ProjectWalk {
  let visited = 0;
  let stopped = false;
  const pruningApplies = !isPrunedTree(scope.path, scope);

  async function* visit(directory: string, depth: number): AsyncGenerator<ProjectEntry> {
    const dirents = [...(await readdirOrEmptyRoot(fs, scope, directory))].sort(byName);
    for (const dirent of dirents) {
      if (!dirent.isFile && !dirent.isDirectory) {
        continue;
      }
      if (visited >= DISCOVERY_MAX_TRAVERSAL_ENTRIES) {
        stopped = true;
        return;
      }
      visited += 1;
      const path = joinPath(directory, dirent.name);
      const type = dirent.isDirectory ? ('dir' as const) : ('file' as const);
      yield { path, type };
      if (!recursive || type !== 'dir' || (pruningApplies && isPrunedTree(path, scope))) {
        continue;
      }
      if (depth >= DISCOVERY_MAX_TRAVERSAL_DEPTH) {
        stopped = true;
        continue;
      }
      yield* visit(path, depth + 1);
    }
  }

  return { entries: visit(scope.path, 1), stopped: () => stopped };
}

function isPrunedTree(path: string, scope: DiscoveryScope): boolean {
  const segment = relativeSegment(path, scope.root);
  return segment !== null && scope.prunedRoots.has(segment);
}

/** First path segment below the project root, or null for the root itself and anything outside it. */
function relativeSegment(path: string, root: string): string | null {
  return path.startsWith(`${root}/`) ? (path.slice(root.length + 1).split('/')[0] ?? null) : null;
}

/** A workspace that has never been seeded has no project directory at all; that is an empty project, not a failure. */
async function readdirOrEmptyRoot(fs: DiscoveryFilesystem, scope: DiscoveryScope, directory: string) {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (directory === scope.root && isMissingPath(error)) {
      return [];
    }
    throw error;
  }
}

/** A file that vanished between the stat and the read is skipped on the same terms as one that vanished before it. */
async function readFileOrNull(fs: DiscoveryFilesystem, path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (error) {
    if (isMissingPath(error)) {
      return null;
    }
    throw error;
  }
}

/** A file that vanished between enumeration and stat is skipped, not a failure for the whole search. */
async function fileSize(fs: DiscoveryFilesystem, path: string): Promise<number | null> {
  try {
    const stat = await fs.stat(path);
    return stat.isFile ? stat.size : null;
  } catch (error) {
    if (isMissingPath(error)) {
      return null;
    }
    throw error;
  }
}

function truncateMatchText(line: string): string {
  return line.length <= DISCOVERY_MAX_MATCH_TEXT_CHARS ? line : `${line.slice(0, DISCOVERY_MAX_MATCH_TEXT_CHARS)}…`;
}

function joinPath(directory: string, name: string): string {
  return directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`;
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyntaxError('Workspace discovery request must be an object.');
  }
  return value as Record<string, unknown>;
}

function requireOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || typeof value === 'boolean') {
    return value;
  }
  throw new SyntaxError(`Invalid ${name}.`);
}

/** An omitted or over-large count becomes the ceiling; a nonsensical one is rejected. */
function requireBoundedCount(value: unknown, name: string, ceiling: number): number {
  if (value === undefined) {
    return ceiling;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new SyntaxError(`Invalid ${name}.`);
  }
  return Math.min(value, ceiling);
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if ('code' in error && error.code === 'ENOENT') {
    return true;
  }
  return 'message' in error && typeof error.message === 'string' && /ENOENT|no such (file|path)/i.test(error.message);
}
