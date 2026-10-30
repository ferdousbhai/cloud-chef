export function requireWorkspaceFileEncoding(value: unknown): 'utf8' | 'base64' {
  if (value === undefined || value === 'utf8') {
    return 'utf8';
  }
  if (value === 'base64') {
    return value;
  }
  throw new SyntaxError('Invalid workspace file encoding.');
}

/**
 * An absolute workspace path in one canonical spelling: forward slashes, no repeated or trailing slash,
 * and no `.` segment, so `/home/project/.` is the project root and is checked as one. A `..` segment
 * or a NUL is refused rather than resolved.
 */
export function canonicalAbsolutePath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (!normalized.startsWith('/') || segments.includes('..') || normalized.includes('\0')) {
    throw new SyntaxError('Invalid absolute workspace path.');
  }
  return `/${segments.filter((segment) => segment !== '' && segment !== '.').join('/')}`;
}

/** `path` (canonical) inside the project at `root`; the root itself only where `allowRoot` says. */
export function projectPath(path: string, root: string, allowRoot: boolean): string {
  if ((allowRoot && path === root) || path.startsWith(`${root}/`)) {
    return path;
  }
  // The root stays rejected where a single file is named — reads want a file, and a change set
  // naming the root would delete or overwrite the whole project — but say so, rather than
  // claiming the project root is not under the project root.
  throw new SyntaxError(
    path === root ? `${root} is the project directory; name a path inside it.` : `Path must be under ${root}.`,
  );
}
