import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATABASE_NAME = 'cloudchef';
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const BUILD_UUID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const D1_RESTORE_RECEIPT_MARKER = 'CLOUDCHEF_D1_RESTORE_RECEIPT';

export function parseD1TimeTravelBookmark(output) {
  const result = JSON.parse(output);
  if (!result || typeof result !== 'object' || typeof result.bookmark !== 'string') {
    throw new Error('Cloudflare D1 Time Travel did not return a bookmark.');
  }
  const bookmark = result.bookmark.trim();
  if (!/^[A-Za-z0-9-]+$/.test(bookmark)) {
    throw new Error('Cloudflare D1 Time Travel returned an invalid bookmark.');
  }
  return bookmark;
}

export function formatD1RestoreSummary(bookmark, { buildUuid, commitSha, provider }) {
  return [
    '### Pre-migration D1 restore point',
    '',
    `- Database: \`${DATABASE_NAME}\``,
    `- Commit: \`${commitSha}\``,
    `- Build: \`${buildUuid}\``,
    `- Provider: \`${provider}\``,
    `- Bookmark: \`${bookmark}\``,
    `- Restore command: \`pnpm exec wrangler d1 time-travel restore ${DATABASE_NAME} --bookmark=${bookmark}\``,
    '',
  ].join('\n');
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>;
 * }} [options]
 */
export function resolveReleaseIdentity({ env = process.env } = {}) {
  if (env.WORKERS_CI !== '1') {
    throw new Error('The D1 restore receipt may be created only by Cloudflare Workers Builds.');
  }
  const commitSha = (env.WORKERS_CI_COMMIT_SHA ?? '').trim();
  if (!COMMIT_SHA_PATTERN.test(commitSha)) {
    throw new Error('The D1 restore receipt requires an exact lowercase 40-hex Git commit ID.');
  }
  const buildUuid = (env.WORKERS_CI_BUILD_UUID ?? '').trim();
  if (!BUILD_UUID_PATTERN.test(buildUuid)) {
    throw new Error('The D1 restore receipt requires a valid WORKERS_CI_BUILD_UUID.');
  }
  return { buildUuid, commitSha, provider: 'cloudflare-workers-builds' };
}

export function recordD1TimeTravelBookmark({
  query = () =>
    execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'time-travel', 'info', DATABASE_NAME, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  identity = resolveReleaseIdentity(),
} = {}) {
  const bookmark = parseD1TimeTravelBookmark(query());
  const summary = formatD1RestoreSummary(bookmark, identity);
  const receipt = {
    bookmark,
    buildUuid: identity.buildUuid || null,
    commitSha: identity.commitSha,
    database: DATABASE_NAME,
    provider: identity.provider,
  };

  process.stdout.write(`${summary}\n${D1_RESTORE_RECEIPT_MARKER} ${JSON.stringify(receipt)}\n`);
  return bookmark;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  recordD1TimeTravelBookmark();
}
