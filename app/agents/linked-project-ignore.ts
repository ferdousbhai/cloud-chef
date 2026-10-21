import ignore from 'ignore';

const PUBLISHED_ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);

/**
 * Local secrets a publish never sends, whatever the repository's `.gitignore` says and even when GitHub
 * already has the file: `.env`, `.env.*` (all but the documented examples) and `.dev.vars`, `.dev.vars.*`,
 * at any depth. `.envrc` or `.environment.ts` is an ordinary file.
 */
export function isNeverPublished(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (PUBLISHED_ENV_EXAMPLES.has(name)) {
    return false;
  }
  return ['.env', '.dev.vars'].some((secret) => name === secret || name.startsWith(`${secret}.`));
}

/**
 * Whether git would ignore a path, from the project's `.gitignore` files (each as `{ path, content }`,
 * relative to the project root), as git decides it: a deeper file's rules come after its parents', a
 * later rule (a `!` negation included) overrides an earlier one, and nothing inside an ignored directory
 * can be re-included, since git never looks inside it. Like git, it says nothing of whether the file is
 * tracked: a file the repository already has is published whether or not it is ignored.
 */
export function gitignoreMatcher(gitignores: readonly { path: string; content: string }[]): (path: string) => boolean {
  const scopes = gitignores
    .map((file) => ({ directory: parentDirectory(file.path), rules: parseRules(file.content) }))
    .sort((left, right) => depth(left.directory) - depth(right.directory));
  const directories = new Map<string, boolean>();

  // Only the rules matching this exact path decide it: its directories are decided on their own, across
  // every scope, by `ignoredDirectory`.
  function lastDecision(path: string): boolean {
    let ignored = false;
    for (const scope of scopes) {
      const prefix = scope.directory ? `${scope.directory}/` : '';
      if (!path.startsWith(prefix) || path.length === prefix.length) {
        continue;
      }
      const relative = path.slice(prefix.length);
      for (const rule of scope.rules) {
        if (rule.matches.test(relative).unignored) {
          ignored = rule.ignores;
        }
      }
    }
    return ignored;
  }

  function ignoredDirectory(directory: string): boolean {
    if (!directory) {
      return false;
    }
    let ignored = directories.get(directory);
    if (ignored === undefined) {
      ignored = ignoredDirectory(parentDirectory(directory)) || lastDecision(`${directory}/`);
      directories.set(directory, ignored);
    }
    return ignored;
  }

  // Nothing inside an ignored directory is re-included, by any file's rules: git never reads it.
  return (path) => ignoredDirectory(parentDirectory(path)) || lastDecision(path);
}

/**
 * A `.gitignore`'s rules in order, each held as a negation: `ignore` tests a path's directories before
 * the path itself and stops at one a rule ignores, but a negation never ignores, so its `unignored` says
 * whether the pattern matches that exact path. A line `ignore` can't compile (one ending in an odd run of
 * three or more backslashes) is dropped, as git leaves out a pattern it can't use.
 */
function parseRules(content: string): { ignores: boolean; matches: ignore.Ignore }[] {
  const rules: { ignores: boolean; matches: ignore.Ignore }[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) {
      continue;
    }
    const ignores = !line.startsWith('!');
    const matches = ignore({ ignorecase: false }).add(ignores ? `!${line}` : line);
    try {
      // `ignore` compiles a rule the first time it tests a path, any path.
      matches.test('a');
    } catch {
      continue;
    }
    rules.push({ ignores, matches });
  }
  return rules;
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function depth(directory: string): number {
  return directory ? directory.split('/').length : 0;
}
