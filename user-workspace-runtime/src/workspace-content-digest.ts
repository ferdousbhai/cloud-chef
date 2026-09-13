import { sha256Hex } from '../../app/lib/hex-digest';
import { shellQuote } from './shell-quote';

/**
 * Prove that an isolated build root actually contains the revision it claims to.
 *
 * Validation, preview, and deployment all build from a copy of the container's mounted
 * `/home/project`, while every guard around them — the checkpoint, the validated revision, the
 * deployment session — reads the durable VFS. Those are two different sources of truth, checked
 * and consumed on opposite sides of each other. After a container recycle the FUSE view was
 * observed frozen at pre-edit content while the VFS held the new files: `read` returned the new
 * bytes, every revision guard passed, validation "passed", and three consecutive deployments
 * reported success while shipping byte-identical stale code (#139).
 *
 * Nothing in that chain could notice, because nothing ever compared the two. This does: one
 * aggregate digest over the copied tree, computed the same way on both sides, so a divergence is
 * a loud failure instead of a confident lie.
 */

/** A VFS file as the workspace reports it: an absolute project path and its content hash. */
type ProjectFileDigest = { path: string; sha256: string };

/**
 * Canonical text both sides hash: `<sha256>  <relative path>` per line, sorted by path under a
 * byte-order collation, newline-terminated. Matching `sha256sum`'s own output format keeps the
 * container side a plain pipeline rather than a bespoke serializer.
 */
export function projectContentDigestInput(
  files: readonly ProjectFileDigest[],
  toRelativePath: (path: string) => string,
  excludedRoots: ReadonlySet<string>,
): string {
  return files
    .map((file) => ({ relative: toRelativePath(file.path), sha256: file.sha256 }))
    .filter((file) => !excludedRoots.has(file.relative.split('/')[0] ?? ''))
    .sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0))
    .map((file) => `${file.sha256}  ${file.relative}\n`)
    .join('');
}

/**
 * The same aggregate, computed inside the container over an isolated root.
 *
 * `LC_ALL=C` so the sort collates by byte exactly as the JavaScript comparison does, and `-print0`
 * so a path containing whitespace or a newline cannot forge a line. The checksum records stay
 * NUL-delimited (`sha256sum --zero`) until the very end: given a name holding a backslash or a
 * newline, plain `sha256sum` escapes it and prefixes the line with `\`, which the JavaScript side
 * never does — the two digests could then never agree, and both guards that consume this
 * comparison fail closed, wedging exec and validation for the life of that file. Converting to the
 * canonical newline text only after the rewrite keeps both sides byte-identical. Emits only the
 * digest, so the check costs one line of exec output regardless of project size.
 */
export function isolatedContentDigestCommand(args: { root: string; excludedRoots: ReadonlySet<string> }): string {
  const prunes = [...args.excludedRoots]
    .sort()
    .map((root) => `-path ${shellQuote(`./${root}`)} -prune -o`)
    .join(' ');
  return [
    'set -eu',
    `cd ${shellQuote(args.root)}`,
    `find . ${prunes} -type f -print0 \\`,
    '  | LC_ALL=C sort -z \\',
    '  | xargs -0 -r sha256sum --zero \\',
    // `find .` prints "./a/b"; the VFS side has "a/b".
    "  | sed -z 's|  \\./|  |' \\",
    "  | tr '\\0' '\\n' \\",
    '  | sha256sum \\',
    "  | cut -d' ' -f1",
  ].join('\n');
}

/** Reduce the canonical text to the single value the container command emits. */
export function projectContentDigest(input: string): Promise<string> {
  return sha256Hex(input);
}
