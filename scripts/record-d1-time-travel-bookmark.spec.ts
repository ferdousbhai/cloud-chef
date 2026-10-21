import { describe, expect, it, vi } from 'vitest';
import {
  controlPlaneDatabaseId,
  d1BookmarkArgs,
  D1_RESTORE_RECEIPT_MARKER,
  formatD1RestoreSummary,
  parseD1TimeTravelBookmark,
  recordD1TimeTravelBookmark,
  resolveReleaseIdentity,
} from './record-d1-time-travel-bookmark.mjs';

const commitSha = 'a'.repeat(40);
const databaseId = '04680db0-07a0-468d-9547-e07f5091756c';

describe('D1 Time Travel bookmark recording', () => {
  it('parses a valid cf response and rejects missing or unsafe values', () => {
    expect(parseD1TimeTravelBookmark('{"bookmark":"00000000-0000-0000-0000-000000000000"}')).toBe(
      '00000000-0000-0000-0000-000000000000',
    );
    expect(() => parseD1TimeTravelBookmark('{}')).toThrow('did not return a bookmark');
    expect(() => parseD1TimeTravelBookmark('{"bookmark":"unsafe value"}')).toThrow('returned an invalid bookmark');
  });

  it('formats the exact Workers Builds identity and restore command', () => {
    const summary = formatD1RestoreSummary('bookmark-1', {
      buildUuid: '11111111-2222-3333-8444-555555555555',
      commitSha,
      provider: 'cloudflare-workers-builds',
      databaseId,
    });
    expect(summary).toContain(`\`pnpm exec cf d1 time-travel restore ${databaseId} --bookmark=bookmark-1\``);
    expect(summary).toContain(`- Commit: \`${commitSha}\``);
    expect(summary).toContain('- Build: `11111111-2222-3333-8444-555555555555`');
    expect(summary).toContain('- Provider: `cloudflare-workers-builds`');
  });

  it('reads the bookmark with cf, addressing the database cloudflare.config.ts binds as DB', () => {
    expect(d1BookmarkArgs(databaseId)).toEqual(['exec', 'cf', 'd1', 'time-travel', 'get-bookmark', databaseId]);
    expect(controlPlaneDatabaseId({ d1_databases: [{ binding: 'DB', database_id: databaseId }] })).toBe(databaseId);
    expect(() =>
      controlPlaneDatabaseId({
        d1_databases: [{ binding: 'DB', database_id: '00000000-0000-0000-0000-000000000000' }],
      }),
    ).toThrow('provisioned D1 database id');
  });

  it('resolves Workers Builds release identity from provider metadata', () => {
    expect(
      resolveReleaseIdentity({
        env: {
          WORKERS_CI: '1',
          WORKERS_CI_BUILD_UUID: '11111111-2222-3333-8444-555555555555',
          WORKERS_CI_COMMIT_SHA: commitSha,
        },
      }),
    ).toEqual({
      buildUuid: '11111111-2222-3333-8444-555555555555',
      commitSha,
      provider: 'cloudflare-workers-builds',
    });
  });

  it('rejects non-Workers Builds identities', () => {
    expect(() => resolveReleaseIdentity({ env: {} })).toThrow('only by Cloudflare Workers Builds');
  });

  it('prints the recovery summary and machine-readable receipt', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      expect(
        recordD1TimeTravelBookmark({
          databaseId,
          query: () => '{"bookmark":"bookmark-2"}',
          identity: {
            buildUuid: '11111111-2222-3333-8444-555555555555',
            commitSha,
            provider: 'cloudflare-workers-builds',
          },
        }),
      ).toBe('bookmark-2');
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining(`- Commit: \`${commitSha}\``));
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining(D1_RESTORE_RECEIPT_MARKER));
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining(`"databaseId":"${databaseId}"`));
    } finally {
      stdout.mockRestore();
    }
  });
});
