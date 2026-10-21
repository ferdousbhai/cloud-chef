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

  it('ignores nothing without a .gitignore', () => {
    expect(gitignoreMatcher([])('coverage/index.html')).toBe(false);
  });
});
