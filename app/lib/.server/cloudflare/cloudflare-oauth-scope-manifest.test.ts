import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CORE_CLOUDFLARE_OAUTH_SCOPES,
  missingCoreOAuthScopes,
  parseReportedOAuthScopes,
} from './cloudflare-oauth-scope-manifest';

describe('cloudflare-oauth-scope-manifest', () => {
  test('normalizes a provider-reported scope string and drops offline_access', () => {
    const reported = `offline_access ${CORE_CLOUDFLARE_OAUTH_SCOPES.join('  ')} d1.write`;
    expect(parseReportedOAuthScopes(reported)).toEqual({ granted: [...CORE_CLOUDFLARE_OAUTH_SCOPES] });
  });

  test('rejects scope IDs outside the reviewed manifest instead of storing them', () => {
    expect(parseReportedOAuthScopes('d1.write registrar.write')).toEqual({ unknownScopes: ['registrar.write'] });
  });

  test('names every missing core scope', () => {
    expect(missingCoreOAuthScopes(CORE_CLOUDFLARE_OAUTH_SCOPES.filter((scope) => scope !== 'd1.write'))).toEqual([
      'd1.write',
    ]);
    expect(missingCoreOAuthScopes([...CORE_CLOUDFLARE_OAUTH_SCOPES])).toEqual([]);
  });

  test('reads Workers Builds, and can remove a deleted project’s triggers', () => {
    // A connection authorized before a scope was added reauthorizes before it is used again.
    expect(CORE_CLOUDFLARE_OAUTH_SCOPES).toContain('workers-ci.read');
    expect(CORE_CLOUDFLARE_OAUTH_SCOPES).toContain('workers-ci.write');
    expect(
      missingCoreOAuthScopes(CORE_CLOUDFLARE_OAUTH_SCOPES.filter((scope) => scope !== 'workers-ci.write')),
    ).toEqual(['workers-ci.write']);
  });

  test('every manifest scope exists in the checked-in provider catalog', () => {
    // The catalog is the reviewed capture of GET /oauth/scopes. A digest change means the
    // provider catalog was re-fetched; review the diff, then update the recorded digest here.
    const catalogPath = 'app/lib/.server/cloudflare/cloudflare-oauth-scope-catalog-2026-10-24.tsv';
    const catalogBytes = readFileSync(catalogPath);
    expect(createHash('sha256').update(catalogBytes).digest('hex')).toBe(
      '685d78fe31359ffd104f2adeccc7613c6cf20e9a22316d4bf6c8f9760ab37c59',
    );
    const rows = catalogBytes.toString('utf8').trimEnd().split('\n');
    const ids = new Set(rows.map((row) => row.split('\t')[0]));
    expect(rows).toHaveLength(400);
    expect(ids.size).toBe(rows.length);
    for (const scope of CORE_CLOUDFLARE_OAUTH_SCOPES) {
      expect(ids.has(scope), scope).toBe(true);
    }
    // offline_access is an OAuth protocol scope, not a catalog permission; the manifest and the
    // orchestrator treat it separately and the catalog proves it never collides with an ID.
    expect(ids.has('offline_access')).toBe(false);
  });
});
