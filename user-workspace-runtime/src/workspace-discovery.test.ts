import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_MAX_LIST_ENTRIES,
  DISCOVERY_MAX_MATCH_TEXT_CHARS,
  DISCOVERY_MAX_MATCHES,
  DISCOVERY_MAX_OUTPUT_BYTES,
  DISCOVERY_MAX_PATTERN_CHARS,
  DISCOVERY_MAX_SEARCH_FILE_BYTES,
  DISCOVERY_MAX_SEARCH_FILES,
  DISCOVERY_MAX_TRAVERSAL_DEPTH,
  enumerateProjectEntries,
  requireProjectListingOptions,
  requireProjectSearchOptions,
  scanProjectFiles,
  type DiscoveryFilesystem,
  type DiscoveryScope,
} from './workspace-discovery';

const ROOT = '/home/project';
const PRUNED = new Set(['node_modules', 'dist']);

describe('workspace discovery listing', () => {
  it('shows generated directories but never walks into them', async () => {
    const fs = fakeFilesystem({
      '/home/project/src/app.ts': 'export {};',
      '/home/project/dist/bundle.js': 'x',
      '/home/project/node_modules/@tanstack/react-start/package.json': '{}',
    });

    const listing = await enumerateProjectEntries(fs, scope(), { recursive: true, limit: 100 });

    expect(listing.entries.map((entry) => entry.path)).toEqual([
      '/home/project/dist',
      '/home/project/node_modules',
      '/home/project/src',
      '/home/project/src/app.ts',
    ]);
  });

  it('walks inside a generated directory when that directory is the requested scope', async () => {
    const fs = fakeFilesystem({
      '/home/project/node_modules/@tanstack/react-start/package.json': '{}',
    });

    const listing = await enumerateProjectEntries(fs, scope('/home/project/node_modules/@tanstack'), {
      recursive: true,
      limit: 100,
    });

    expect(listing.entries.map((entry) => entry.path)).toEqual([
      '/home/project/node_modules/@tanstack/react-start',
      '/home/project/node_modules/@tanstack/react-start/package.json',
    ]);
  });

  it('reports truncation and stops reading rather than returning an unbounded listing', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`/home/project/src/file-${index}.ts`, 'export {};']),
    );
    const fs = fakeFilesystem(files);

    const listing = await enumerateProjectEntries(fs, scope(), { recursive: true, limit: 3 });

    expect(listing.entryCount).toBe(3);
    expect(listing.truncated).toBe(true);
  });

  it('treats a workspace that was never seeded as an empty project, not a failure', async () => {
    const listing = await enumerateProjectEntries(fakeFilesystem({}), scope(), { recursive: true, limit: 10 });

    expect(listing).toMatchObject({ entryCount: 0, truncated: false });
  });

  it('surfaces a missing subdirectory instead of pretending it is empty', async () => {
    const fs = fakeFilesystem({ '/home/project/src/app.ts': 'export {};' });

    await expect(
      enumerateProjectEntries(fs, scope('/home/project/missing'), { recursive: false, limit: 10 }),
    ).rejects.toThrow(/ENOENT/);
  });

  it('terminates on a directory cycle instead of walking forever', async () => {
    // A symlinked directory that resolves back onto its own ancestor is the shape that makes a
    // naive recursive walk non-terminating and takes the Durable Object down with it.
    const fs: DiscoveryFilesystem = {
      readdir: async () => [{ name: 'loop', isFile: false, isDirectory: true }],
      stat: async () => ({ size: 0, isFile: false }),
      readFile: async () => '',
    };

    const listing = await enumerateProjectEntries(fs, scope(), {
      recursive: true,
      limit: DISCOVERY_MAX_LIST_ENTRIES,
    });

    expect(listing.truncated).toBe(true);
    expect(listing.entryCount).toBe(DISCOVERY_MAX_TRAVERSAL_DEPTH);
  });
});

describe('workspace discovery search', () => {
  it('returns the path, the 1-based line, and the matching line', async () => {
    const fs = fakeFilesystem({
      '/home/project/src/app.ts': 'import { createRouter } from "x";\nconst a = 1;\ncreateRouter();\n',
      '/home/project/src/other.ts': 'const b = 2;\n',
    });

    const result = await scanProjectFiles(fs, scope(), {
      pattern: 'createRouter',
      ignoreCase: false,
      limit: 10,
    });

    expect(result.matches).toEqual([
      { path: '/home/project/src/app.ts', line: 1, text: 'import { createRouter } from "x";' },
      { path: '/home/project/src/app.ts', line: 3, text: 'createRouter();' },
    ]);
    expect(result).toMatchObject({ matchCount: 2, filesScanned: 2, truncated: false });
  });

  it('numbers CRLF and BOM files the way read and edit number them', async () => {
    const fs = fakeFilesystem({
      '/home/project/src/app.ts': '﻿one\r\ntwo\r\ntarget\r\n',
    });

    const result = await scanProjectFiles(fs, scope(), { pattern: 'target', ignoreCase: false, limit: 10 });

    expect(result.matches).toEqual([{ path: '/home/project/src/app.ts', line: 3, text: 'target' }]);
  });

  it('matches literally, so regular-expression metacharacters find only themselves', async () => {
    const fs = fakeFilesystem({
      '/home/project/src/app.ts': 'const value = a.b;\nconst literal = "a.*b";\n',
    });

    const result = await scanProjectFiles(fs, scope(), { pattern: 'a.*b', ignoreCase: false, limit: 10 });

    expect(result.matches).toEqual([{ path: '/home/project/src/app.ts', line: 2, text: 'const literal = "a.*b";' }]);
  });

  it('cannot be made to backtrack by a pathological pattern', async () => {
    const fs = fakeFilesystem({
      '/home/project/src/app.ts': `${'a'.repeat(5_000)}\n`,
    });

    const started = Date.now();
    const result = await scanProjectFiles(fs, scope(), {
      // Catastrophic against a backtracking engine; just a needle that is absent here.
      pattern: `${'a'.repeat(40)}!`,
      ignoreCase: false,
      limit: 10,
    });

    expect(result.matchCount).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('skips generated trees, oversized files, and binary blobs', async () => {
    const fs = fakeFilesystem({
      '/home/project/src/app.ts': 'needle\n',
      '/home/project/node_modules/pkg/index.js': 'needle\n',
      '/home/project/huge.txt': `needle\n${'x'.repeat(DISCOVERY_MAX_SEARCH_FILE_BYTES)}`,
      '/home/project/image.bin': 'needle' + String.fromCharCode(0) + '\n',
    });

    const result = await scanProjectFiles(fs, scope(), { pattern: 'needle', ignoreCase: false, limit: 10 });

    expect(result.matches.map((match) => match.path)).toEqual(['/home/project/src/app.ts']);
    expect(result).toMatchObject({ filesScanned: 1, filesSkipped: 2 });
  });

  it('truncates a single enormous matching line instead of spending the whole budget on it', async () => {
    const fs = fakeFilesystem({ '/home/project/src/app.ts': `needle${'x'.repeat(10_000)}\n` });

    const result = await scanProjectFiles(fs, scope(), { pattern: 'needle', ignoreCase: false, limit: 10 });

    expect(result.matches[0]!.text).toHaveLength(DISCOVERY_MAX_MATCH_TEXT_CHARS + 1);
  });

  it('stops opening files at the file ceiling even when nothing matches', async () => {
    const files = Object.fromEntries(
      Array.from({ length: DISCOVERY_MAX_SEARCH_FILES + 5 }, (_, index) => [
        `/home/project/src/file-${String(index).padStart(5, '0')}.ts`,
        'export {};\n',
      ]),
    );

    const result = await scanProjectFiles(fakeFilesystem(files), scope(), {
      pattern: 'absent',
      ignoreCase: false,
      limit: DISCOVERY_MAX_MATCHES,
    });

    expect(result.filesScanned).toBe(DISCOVERY_MAX_SEARCH_FILES);
    expect(result.truncated).toBe(true);
  });

  it('stops at the match ceiling and says so', async () => {
    const fs = fakeFilesystem({
      '/home/project/src/app.ts': 'needle\n'.repeat(50),
    });

    const result = await scanProjectFiles(fs, scope(), { pattern: 'needle', ignoreCase: false, limit: 5 });

    expect(result).toMatchObject({ matchCount: 5, truncated: true });
  });

  it('stops at the shared byte ceiling before the match ceiling when lines are multibyte', async () => {
    // The per-match character cap is counted in characters; the output cap is counted in bytes,
    // which is what a non-Latin source file actually costs the model's context.
    const line = `needle${'漢'.repeat(DISCOVERY_MAX_MATCH_TEXT_CHARS)}`;
    const fs = fakeFilesystem({
      '/home/project/src/app.ts': `${line}\n`.repeat(DISCOVERY_MAX_MATCHES),
    });

    const result = await scanProjectFiles(fs, scope(), {
      pattern: 'needle',
      ignoreCase: false,
      limit: DISCOVERY_MAX_MATCHES,
    });

    expect(result.matchCount).toBeLessThan(DISCOVERY_MAX_MATCHES);
    expect(result.truncated).toBe(true);
    const bytes = result.matches.reduce(
      (total, match) => total + new TextEncoder().encode(match.path + match.text).byteLength,
      0,
    );
    expect(bytes).toBeLessThanOrEqual(DISCOVERY_MAX_OUTPUT_BYTES);
  });
});

describe('workspace discovery request validation', () => {
  it('defaults to the ceilings and rejects nonsense counts', () => {
    expect(requireProjectListingOptions({})).toEqual({ recursive: false, limit: DISCOVERY_MAX_LIST_ENTRIES });
    expect(requireProjectListingOptions({ limit: 10_000 }).limit).toBe(DISCOVERY_MAX_LIST_ENTRIES);
    expect(() => requireProjectListingOptions({ limit: 0 })).toThrow(SyntaxError);
    expect(() => requireProjectListingOptions({ recursive: 'yes' })).toThrow(SyntaxError);
    expect(requireProjectSearchOptions({ pattern: 'x' })).toEqual({
      pattern: 'x',
      ignoreCase: false,
      limit: DISCOVERY_MAX_MATCHES,
    });
  });

  it('rejects a pattern that cannot be answered rather than returning a misleading empty result', () => {
    expect(() => requireProjectSearchOptions({ pattern: '' })).toThrow(SyntaxError);
    expect(() => requireProjectSearchOptions({ pattern: 'a\nb' })).toThrow('single line');
    expect(() => requireProjectSearchOptions({ pattern: 'x'.repeat(DISCOVERY_MAX_PATTERN_CHARS + 1) })).toThrow(
      SyntaxError,
    );
  });
});

function scope(path = ROOT): DiscoveryScope {
  return { path, root: ROOT, prunedRoots: PRUNED };
}

/** In-memory stand-in for the Computer VFS: paths in, directories derived. */
function fakeFilesystem(files: Record<string, string>): DiscoveryFilesystem {
  const encoder = new TextEncoder();
  const directories = new Set<string>();
  for (const path of Object.keys(files)) {
    const segments = path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }
  }
  const missing = (path: string) => Object.assign(new Error(`ENOENT: no such path: ${path}`), { code: 'ENOENT' });

  return {
    async readdir(path) {
      if (!directories.has(path)) {
        throw missing(path);
      }
      const prefix = `${path}/`;
      const names = new Map<string, boolean>();
      for (const filePath of Object.keys(files)) {
        if (!filePath.startsWith(prefix)) {
          continue;
        }
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf('/');
        names.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
      }
      return [...names].map(([name, isDirectory]) => ({ name, isFile: !isDirectory, isDirectory }));
    },
    async stat(path) {
      const content = files[path];
      if (content === undefined) {
        throw missing(path);
      }
      return { size: encoder.encode(content).byteLength, isFile: true };
    },
    async readFile(path) {
      const content = files[path];
      if (content === undefined) {
        throw missing(path);
      }
      return content;
    },
  };
}
