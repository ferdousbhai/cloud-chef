import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

// A `typeof fetch` stored on an object and then called as `holder.request(url)` passes the holder
// as the receiver. Node's fetch ignores its receiver, so such a call passes every unit test; the
// Workers runtime rejects it with "Illegal invocation" on the first production request. That is
// exactly how the workspace image copy shipped broken twice. Behaviour cannot catch this under
// Node, so the shape is checked in the source instead: every call site must destructure first.
const REPOSITORY_ROOT = new URL('..', import.meta.url).pathname;
// Named individually rather than skipping every dot-directory: `app/lib/.server` is hidden by
// that convention and holds every injected-fetch holder this guard exists to check.
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.wrangler',
  '.claude',
  '.vite',
  'dist',
  'coverage',
  'generated',
  'e2e',
]);

function productionSources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // The production-build security tests stage full template copies under this prefix in the
    // repository root and delete them again; walking one mid-run would fail on a vanished path.
    if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.cloudchef-runtime-security-')) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...productionSources(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

// Comments name the broken form in order to warn about it, so they must not count as uses.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Matches the name in `request: typeof fetch`, `request?: typeof fetch` and `fetch: typeof fetch`,
// covering constructor parameters, interface members and standalone declarations alike.
const HOLDER_DECLARATION = /([A-Za-z_$][\w$]*)\s*\??\s*:\s*typeof fetch\b/g;

function methodInvokedHolders(source: string): string[] {
  const code = withoutComments(source);
  const holders = new Set(Array.from(code.matchAll(HOLDER_DECLARATION), (match) => match[1]));
  const invoked: string[] = [];
  for (const holder of holders) {
    // `something.holder(` — the receiver is whatever precedes the dot, including `this`.
    const asMethod = new RegExp(`[A-Za-z_$\\])][\\w$]*\\s*\\.\\s*${holder}\\s*\\(`);
    if (asMethod.test(code)) {
      invoked.push(holder);
    }
  }
  return invoked;
}

describe('injected fetch receiver', () => {
  const sources = productionSources(REPOSITORY_ROOT);

  it('scans the files it is meant to guard', () => {
    // Naming them keeps a traversal bug from silently emptying the scan: an earlier revision
    // skipped every dot-directory, which excluded all of `app/lib/.server` while still finding
    // enough files elsewhere to look healthy.
    const scanned = new Set(sources.map((path) => relative(REPOSITORY_ROOT, path)));

    expect(scanned).toContain('app/lib/.server/cloudflare/user-account-api.ts');
    expect(scanned).toContain('app/workflows/user-workspace-runtime-provisioning.ts');
    expect(scanned).toContain('user-workspace-runtime/src/index.ts');
  });

  it('never calls an injected fetch as a method', () => {
    const offenders = sources.flatMap((path) => {
      const holders = methodInvokedHolders(readFileSync(path, 'utf8'));
      return holders.map((holder) => `${relative(REPOSITORY_ROOT, path)}: ${holder}`);
    });

    expect(offenders).toEqual([]);
  });
});
