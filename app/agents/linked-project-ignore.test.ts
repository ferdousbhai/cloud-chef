import { describe, expect, it } from 'vitest';
import { gitignoreMatcher, isNeverPublished } from './linked-project-ignore';

describe('isNeverPublished', () => {
  it('names local secret files at any depth, but not the example a repository documents them with', () => {
    for (const path of ['.env', '.env.local', 'apps/web/.env.production', '.dev.vars', 'worker/.dev.vars.staging']) {
      expect(isNeverPublished(path)).toBe(true);
    }
    for (const path of ['.env.example', 'apps/web/.env.example', 'src/env.ts', 'README.md', '.gitignore']) {
      expect(isNeverPublished(path)).toBe(false);
    }
  });
});

describe('gitignoreMatcher', () => {
  it('applies the root rules as git does, a later negation included', () => {
    const ignored = gitignoreMatcher([
      { path: '.gitignore', content: '# build output\ncoverage/\nbuild\n*.log\n!keep.log\n/root-only.txt\n' },
    ]);

    expect(ignored('coverage/index.html')).toBe(true);
    expect(ignored('build/app.js')).toBe(true);
    expect(ignored('packages/a/build/app.js')).toBe(true);
    expect(ignored('debug.log')).toBe(true);
    expect(ignored('keep.log')).toBe(false);
    expect(ignored('root-only.txt')).toBe(true);
    expect(ignored('src/root-only.txt')).toBe(false);
    expect(ignored('src/app.ts')).toBe(false);
    // Case matters, as in git on Linux.
    expect(ignored('Build/app.js')).toBe(false);
  });

  it('applies a nested file to its own directory after its parents, and never inside an ignored one', () => {
    const ignored = gitignoreMatcher([
      { path: '.gitignore', content: '*.generated.ts\nvendor/\n' },
      { path: 'packages/api/.gitignore', content: 'tmp/\n!schema.generated.ts\n' },
      { path: 'vendor/.gitignore', content: '!*\n' },
    ]);

    expect(ignored('packages/api/tmp/out.json')).toBe(true);
    expect(ignored('tmp/out.json')).toBe(false);
    expect(ignored('packages/api/schema.generated.ts')).toBe(false);
    expect(ignored('packages/web/schema.generated.ts')).toBe(true);
    expect(ignored('vendor/lib.js')).toBe(true);

    // A deeper file's negation can't reach into a directory a shallower one ignored.
    const generated = gitignoreMatcher([
      { path: '.gitignore', content: 'src/gen/\n' },
      { path: 'src/.gitignore', content: '!gen/schema.ts\n!gen/types/\n!gen/types/api.ts\n' },
    ]);
    expect(generated('src/gen/schema.ts')).toBe(true);
    expect(generated('src/gen/types/api.ts')).toBe(true);
  });

  // Each expectation here is what `git ls-files --others --exclude-standard` says of the same tree.
  it("decides a file by the rules matching it, once a deeper file re-included the directory a parent's rule matched", () => {
    const docs = gitignoreMatcher([
      { path: '.gitignore', content: 'docs/*\n' },
      { path: 'docs/.gitignore', content: '!api/\n' },
    ]);
    expect(docs('docs/api/x.md')).toBe(false);
    expect(docs('docs/api/sub/y.md')).toBe(false);
    expect(docs('docs/other.md')).toBe(true);
    expect(docs('docs/guide/z.md')).toBe(true);

    const packages = gitignoreMatcher([
      { path: '.gitignore', content: 'pkg/*\n!pkg/keep/\n' },
      { path: 'pkg/keep/.gitignore', content: '*.tmp\n' },
    ]);
    expect(packages('pkg/keep/a.ts')).toBe(false);
    expect(packages('pkg/keep/n/b.ts')).toBe(false);
    expect(packages('pkg/keep/a.tmp')).toBe(true);
    expect(packages('pkg/drop/a.ts')).toBe(true);
  });

  it('follows git through an allow-list, a double star, directory-only rules and escapes', () => {
    const allowList = gitignoreMatcher([{ path: '.gitignore', content: '*\n!*/\n!*.ts\n' }]);
    expect(allowList('src/deep/c.ts')).toBe(false);
    expect(allowList('src/b.js')).toBe(true);

    const logs = gitignoreMatcher([{ path: '.gitignore', content: 'logs/**\n!logs/**/\n!*.txt\n' }]);
    expect(logs('logs/d/b.txt')).toBe(false);
    expect(logs('logs/d/b.log')).toBe(true);

    const nested = gitignoreMatcher([
      { path: 'a/.gitignore', content: '*.md\nsub/*\n' },
      { path: 'a/b/.gitignore', content: '!README.md\n' },
      { path: 'a/sub/.gitignore', content: '!*\n' },
    ]);
    expect(nested('a/b/README.md')).toBe(false);
    expect(nested('a/b/other.md')).toBe(true);
    // `sub/*` ignores what is directly in `a/sub`, and `a/sub/.gitignore` re-includes it.
    expect(nested('a/sub/k.ts')).toBe(false);
    expect(nested('a/sub/d/k.ts')).toBe(false);

    const patterns = gitignoreMatcher([{ path: '.gitignore', content: 'out/\n\\#hash\n\\!bang\ntrail.txt   \n' }]);
    expect(patterns('out')).toBe(false);
    expect(patterns('x/out/a')).toBe(true);
    expect(patterns('#hash')).toBe(true);
    expect(patterns('!bang')).toBe(true);
    expect(patterns('trail.txt')).toBe(true);
  });

  it('passes over a line ending in an odd run of backslashes, as git does, and keeps the rest of the file', () => {
    const ignored = gitignoreMatcher([
      { path: '.gitignore', content: 'a\\\\\\\n*.log\n' },
      { path: 'sub/.gitignore', content: 'x\\\\\\\\\\\n' },
    ]);
    expect(ignored('a')).toBe(false);
    expect(ignored('a\\')).toBe(false);
    expect(ignored('x.log')).toBe(true);
    expect(ignored('sub/x')).toBe(false);
  });

  it('ignores nothing without a .gitignore', () => {
    expect(gitignoreMatcher([])('coverage/index.html')).toBe(false);
  });
});
