import { describe, expect, it } from 'vitest';
import {
  RUNTIME_BUSY_LEASE_MS,
  RUNTIME_QUIET_PERIOD_MS,
} from '../app/lib/.server/cloudflare/user-workspace-runtime-activity';
import { assertReadOnlyCf } from './lib/ops-cf.mjs';
import {
  activityStatement,
  BUSY_LEASE_MS,
  containerApplicationDeleter,
  parseArguments,
  QUIET_PERIOD_MS,
  rollBackWorkspaceContainers,
  RUNTIMES_STATEMENT,
  runtimeDatabaseName,
} from './rollback-workspace-containers.mjs';

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const OWN = 'cloudchef-workspace-0123456789abcdef';
const TEAM = 'cloudchef-workspace-fedcba9876543210';

/**
 * Two runtimes in two accounts, each with its two durable_object applications and a platform-scheduled one left
 * from before, and each runtime's D1 answering `activity` for whether it is busy.
 */
function account(activity: Record<string, { active: number; windows: number } | 'unreadable'>) {
  const reads: { args: readonly string[]; accountId?: string }[] = [];
  const deleted: string[] = [];
  const applications = (worker: string) => [
    { id: `${worker}-app`, name: worker, scheduling_policy: 'durable_object' },
    { id: `${worker}-builder-app`, name: `${worker}-builder`, scheduling_policy: 'durable_object' },
    { id: 'someone-else', name: 'storefront', scheduling_policy: 'durable_object' },
  ];
  const read = async (args: readonly string[], options: { accountId?: string } = {}) => {
    reads.push({ args, accountId: options.accountId });
    assertReadOnlyCf(args);
    const worker = options.accountId === 'account-own' ? OWN : TEAM;
    if (args.join(' ') === 'containers applications list') {
      return applications(worker);
    }
    if (args[0] === 'd1' && args[1] === 'list') {
      if (activity[worker] === 'unreadable') {
        throw new Error('Authentication error [code: 10000]');
      }
      return [{ name: runtimeDatabaseName(worker), uuid: `${worker}-db` }];
    }
    const answer = activity[worker];
    return [{ results: [answer === 'unreadable' ? {} : answer] }];
  };
  const remove = async (id: string, accountId: string) => {
    deleted.push(`${accountId} ${id}`);
  };
  const runtimes = async () => [
    { user_id: 'ada', email: 'ada@example.com', organization: null, account_id: 'account-own', worker_name: OWN },
    {
      user_id: 'sara',
      email: 'sara@example.com',
      organization: 'Sites',
      account_id: 'account-team',
      worker_name: TEAM,
    },
  ];
  const lines: string[] = [];
  const run = (options: { apply?: boolean; force?: boolean } = {}) =>
    rollBackWorkspaceContainers({
      runtimes,
      read,
      remove,
      now: () => NOW,
      log: (line) => lines.push(line),
      ...options,
    });
  return { run, reads, deleted, lines };
}

const IDLE = { active: 0, windows: 0 };

describe('rolling back the managed workspace image', () => {
  it('lists each runtime’s two durable_object applications and deletes nothing by default', async () => {
    const { run, deleted, lines, reads } = account({ [OWN]: IDLE, [TEAM]: { active: 1, windows: 0 } });

    expect(await run()).toBe(true);

    expect(deleted).toEqual([]);
    expect(lines[0]).toContain('Dry run');
    expect(lines[1]).toContain(`${OWN} (${OWN}-app), ${OWN}-builder (${OWN}-builder-app); idle`);
    expect(lines[2]).toContain(`${TEAM} (${TEAM}-app), ${TEAM}-builder (${TEAM}-builder-app); busy`);
    expect(lines.join('\n')).not.toContain('storefront');
    // Each runtime is read in its own account.
    expect(new Set(reads.map((call) => call.accountId))).toEqual(new Set(['account-own', 'account-team']));
  });

  it('deletes with --apply only for a runtime that is idle, one runtime at a time, and leaves a busy one', async () => {
    const { run, deleted, lines } = account({ [OWN]: IDLE, [TEAM]: { active: 0, windows: 1 } });

    expect(await run({ apply: true })).toBe(false);

    expect(deleted).toEqual([`account-own ${OWN}-app`, `account-own ${OWN}-builder-app`]);
    expect(lines.join('\n')).toContain('left alone, it is busy (an upgrade window is open)');
  });

  it('warns and asks for --force when a runtime’s activity can’t be read', async () => {
    const unreadable = account({ [OWN]: 'unreadable', [TEAM]: IDLE });

    expect(await unreadable.run({ apply: true })).toBe(false);
    expect(unreadable.deleted).toEqual([`account-team ${TEAM}-app`, `account-team ${TEAM}-builder-app`]);
    expect(unreadable.lines.join('\n')).toContain("WARNING its activity can't be read");
    expect(unreadable.lines.join('\n')).toContain('run again with --force');

    const forced = account({ [OWN]: 'unreadable', [TEAM]: IDLE });
    expect(await forced.run({ apply: true, force: true })).toBe(true);
    expect(forced.deleted).toHaveLength(4);
  });

  it('reads production only with SELECTs, and idleness by the same leases the upgrade window uses', () => {
    expect(BUSY_LEASE_MS).toBe(RUNTIME_BUSY_LEASE_MS);
    expect(QUIET_PERIOD_MS).toBe(RUNTIME_QUIET_PERIOD_MS);
    for (const statement of [RUNTIMES_STATEMENT, activityStatement(NOW)]) {
      expect(statement.trim()).toMatch(/^SELECT\b/i);
      expect(statement).not.toMatch(/\b(?:DELETE|INSERT|REPLACE|UPDATE|DROP|ALTER|CREATE)\b/i);
      expect(() => assertReadOnlyCf(['d1', 'query', 'db', '--body', JSON.stringify({ sql: statement })])).not.toThrow();
    }
    expect(() => assertReadOnlyCf(['containers', 'applications', 'delete', 'x'])).toThrow('read-only');
  });

  it('deletes through cf in the runtime’s account, and only an id Cloudflare could report', async () => {
    const runs: { args: readonly string[]; account: string | undefined }[] = [];
    const remove = containerApplicationDeleter({
      run: async (_file: string, args: readonly string[], options: { env: Record<string, string | undefined> }) => {
        runs.push({ args, account: options.env.CLOUDFLARE_ACCOUNT_ID });
        return { stdout: '', stderr: '' };
      },
      env: {},
    });

    await remove('a1b2-c3', 'account-team');
    await expect(remove('x; rm -rf /', 'account-team')).rejects.toThrow('Refused');

    expect(runs).toEqual([
      {
        args: ['exec', 'cf', 'containers', 'applications', 'delete', 'a1b2-c3', '--force'],
        account: 'account-team',
      },
    ]);
  });

  it('defaults to a dry run, and takes --force only with --apply', () => {
    expect(parseArguments([])).toEqual({ apply: false, force: false });
    expect(parseArguments(['--dry-run'])).toEqual({ apply: false, force: false });
    expect(parseArguments(['--apply', '--force'])).toEqual({ apply: true, force: true });
    expect(parseArguments(['--force'])).toEqual({ error: '--force only applies with --apply.' });
    expect(parseArguments(['--apply', '--dry-run'])).toEqual({ error: 'Choose --dry-run or --apply, not both.' });
    expect(parseArguments(['--yes'])).toEqual({ error: 'Unknown option --yes.' });
  });
});
