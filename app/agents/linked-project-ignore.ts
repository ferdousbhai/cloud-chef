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
    // The last rule matching decides, so the rules are walked back from the deepest file's last.
    for (let index = scopes.length - 1; index >= 0; index--) {
      const scope = scopes[index];
      const prefix = scope.directory ? `${scope.directory}/` : '';
      if (!path.startsWith(prefix) || path.length === prefix.length) {
        continue;
      }
      const relative = path.slice(prefix.length);
      for (let rule = scope.rules.length - 1; rule >= 0; rule--) {
        if (scope.rules[rule].matches.test(relative)) {
          return scope.rules[rule].ignores;
        }
      }
    }
    return false;
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
 * A `.gitignore`'s rules in order, each as the regular expression `ignore` compiles its pattern to. Only
 * the expression is kept, not an `ignore` instance: an instance remembers every path and parent directory
 * it tests, which across a project's rules and files outgrows the Worker's memory. A line `ignore` can't
 * compile (one ending in an odd run of three or more backslashes) is dropped, as git leaves out a pattern
 * it can't use.
 */
function parseRules(content: string): { ignores: boolean; matches: RegExp }[] {
  const rules: { ignores: boolean; matches: RegExp }[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) {
      continue;
    }
    const ignores = !line.startsWith('!');
    const matches = compiledNegation(ignores ? `!${line}` : line);
    if (matches) {
      rules.push({ ignores, matches });
    }
  }
  return rules;
}

/**
 * The expression `ignore` tests an exact path against for one negated line, read from the rule it parsed:
 * `ignore` doesn't publish it, but each rule holds it as `regex`, built when first read and throwing for a
 * pattern it can't compile. As a negation, a leading `\!` or `\#` is unescaped like any other pattern's.
 * Nothing when `ignore` makes no rule of the line or can't compile it; a changed `ignore` that no longer
 * holds the expression throws, rather than letting every rule silently match nothing.
 */
function compiledNegation(line: string): RegExp | undefined {
  const manager: object = ignore({ ignorecase: false }).add(line);
  const parsed = '_rules' in manager && manager._rules instanceof Object ? manager._rules : {};
  const rules = '_rules' in parsed ? parsed._rules : undefined;
  if (!Array.isArray(rules)) {
    throw new Error('ignore no longer holds the rules it parsed');
  }
  const [rule]: object[] = rules;
  if (!rule) {
    return undefined;
  }
  if (!('regex' in rule)) {
    throw new Error('ignore no longer compiles a rule to a regex');
  }
  let regex: unknown;
  try {
    regex = rule.regex;
  } catch {
    return undefined;
  }
  if (!(regex instanceof RegExp)) {
    throw new Error('ignore no longer compiles a rule to a regex');
  }
  return regex;
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function depth(directory: string): number {
  return directory ? directory.split('/').length : 0;
}
