import { describe, expect, it, vi } from 'vitest';
import {
  D1_RESTORE_RECEIPT_MARKER,
  formatD1RestoreSummary,
  parseD1TimeTravelBookmark,
  recordD1TimeTravelBookmark,
  resolveReleaseIdentity,
} from './record-d1-time-travel-bookmark.mjs';

const commitSha = 'a'.repeat(40);

describe('D1 Time Travel bookmark recording', () => {
  it('parses a valid Wrangler response and rejects missing or unsafe values', () => {
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
    });
    expect(summary).toContain('`pnpm exec wrangler d1 time-travel restore cloudchef --bookmark=bookmark-1`');
    expect(summary).toContain(`- Commit: \`${commitSha}\``);
    expect(summary).toContain('- Build: `11111111-2222-3333-8444-555555555555`');
    expect(summary).toContain('- Provider: `cloudflare-workers-builds`');
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
    } finally {
      stdout.mockRestore();
    }
  });
});
