/**
 * Rolling back the managed workspace image: after the previous release is deployed, each runtime's two
 * `durable_object` container applications (`<worker>` and `<worker>-builder`) are deleted, so the earlier release's
 * provisioning finds none and creates its platform-scheduled ones (ARCHITECTURE.md, Rolling back).
 *
 * It reads the runtimes from the control plane's D1 with SELECT statements through the operator's own `cf` login, as
 * `pnpm run ops` does, and each runtime's applications and activity in the runtime's own account. By default it only
 * prints what it would delete. With `--apply` it deletes them one runtime at a time, each only while that runtime's
 * own D1 shows it idle (no recent work and no upgrade window open); a runtime whose activity can't be read is left
 * alone with a warning unless `--force` is given, and a busy one is always left for a later run.
 */
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { bounded, cfReader, execFileAsync, extractJson, HOUR, MINUTE } from './lib/ops-cf.mjs';
import { queryProduction } from './ops-report.mjs';

const applicationSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  scheduling_policy: z.string().optional(),
});
const applicationsSchema = z.union([
  z.array(z.unknown()),
  z.looseObject({ applications: z.array(z.unknown()).optional(), result: z.array(z.unknown()).optional() }),
]);

/** The policy the managed image's applications run under; the earlier release can't use these. */
const DURABLE_OBJECT_POLICY = 'durable_object';
/** As `RUNTIME_BUSY_LEASE_MS` (a turn's four hours and half an hour) and `RUNTIME_QUIET_PERIOD_MS`. */
export const BUSY_LEASE_MS = 4 * HOUR + 30 * MINUTE;
export const QUIET_PERIOD_MS = 2 * MINUTE;
const WORKER_NAME_PATTERN = /^cloudchef-workspace-[a-f0-9]{16}$/;
/** A container application id as Cloudflare reports one; nothing else reaches the delete command. */
const APPLICATION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export const USAGE = `Usage: pnpm run rollback:workspace-containers -- [--dry-run | --apply [--force]]

Lists every workspace runtime and the durable_object container applications a rollback of the
managed image deletes (<worker> and <worker>-builder). Run it after deploying the previous release.

  --dry-run  print what it would delete (the default)
  --apply    delete them, one runtime at a time, each only while its activity shows it idle
  --force    with --apply, also delete for a runtime whose activity can't be read
  --help     show this message`;

/** Every workspace runtime, with whose it is and the account it is in. */
export const RUNTIMES_STATEMENT = `SELECT runtimes.user_id AS user_id, users.email AS email,
    organizations.name AS organization, connections.account_id AS account_id,
    runtimes.worker_name AS worker_name, runtimes.status AS status
  FROM user_computer_runtimes AS runtimes
  JOIN cloudflare_connections AS connections ON connections.id = runtimes.connection_id
  LEFT JOIN organizations ON organizations.id = connections.org_id
  LEFT JOIN "user" AS users ON users.id = runtimes.user_id
  ORDER BY users.email, organizations.name`;

/** The runtime's own database, named beside its Worker (`workspaceRuntimeNames`). */
export function runtimeDatabaseName(workerName) {
  return workerName.replace(/^cloudchef-workspace-/, 'cloudchef-data-');
}

/**
 * What in the runtime's D1 says it is not idle at `now`: work recorded as busy within its lease or ended within the
 * quiet period, and an upgrade window still open. The same test its upgrade window is granted by.
 */
export function activityStatement(now) {
  return `SELECT
    (SELECT COUNT(*) FROM runtime_activity
      WHERE (busy = 1 AND updated_at > ${now - BUSY_LEASE_MS}) OR (busy = 0 AND updated_at > ${now - QUIET_PERIOD_MS}))
      AS active,
    (SELECT COUNT(*) FROM runtime_upgrade_window WHERE id = 1 AND expires_at > ${now}) AS windows`;
}

/**
 * The account's `durable_object` applications of one runtime, by name. `cf` may answer a list or an envelope.
 * @param {unknown} listed
 * @param {string} workerName
 */
export function runtimeApplications(listed, workerName) {
  const parsed = applicationsSchema.safeParse(listed);
  if (!parsed.success) {
    throw new Error('cf returned container applications that are not a list.');
  }
  const applications = Array.isArray(parsed.data)
    ? parsed.data
    : (parsed.data.applications ?? parsed.data.result ?? []);
  const names = [workerName, `${workerName}-builder`];
  return applications
    .flatMap((application) => {
      const read = applicationSchema.safeParse(application);
      return read.success && names.includes(read.data.name) && read.data.scheduling_policy === DURABLE_OBJECT_POLICY
        ? [{ id: read.data.id, name: read.data.name }]
        : [];
    })
    .sort((left, right) => names.indexOf(left.name) - names.indexOf(right.name));
}

/**
 * Whether a runtime is idle now, from its own D1: true or false, or null with why when it can't be read.
 * @param {(args: readonly string[], options?: { accountId?: string }) => Promise<any>} read
 * @param {{ workerName: string; accountId: string }} runtime
 * @param {number} now
 */
export async function readIdle(read, runtime, now) {
  try {
    const databaseName = runtimeDatabaseName(runtime.workerName);
    const databases = await read(['d1', 'list', '--name', databaseName], { accountId: runtime.accountId });
    const database = (Array.isArray(databases) ? databases : []).find((listed) => listed?.name === databaseName);
    if (!database?.uuid) {
      return { idle: null, reason: `its database ${databaseName} isn't in the account` };
    }
    const answer = await read(
      ['d1', 'query', String(database.uuid), '--body', JSON.stringify({ sql: activityStatement(now) })],
      {
        accountId: runtime.accountId,
      },
    );
    const row = Array.isArray(answer) ? answer[0]?.results?.[0] : null;
    if (!row) {
      return { idle: null, reason: 'its activity query returned nothing' };
    }
    const active = Number(row.active ?? 0);
    const windows = Number(row.windows ?? 0);
    if (windows > 0) {
      return { idle: false, reason: 'an upgrade window is open' };
    }
    if (active > 0) {
      return {
        idle: false,
        reason: `${active} piece${active === 1 ? '' : 's'} of work recorded as running or just ended`,
      };
    }
    return { idle: true, reason: 'nothing running and no upgrade window open' };
  } catch (error) {
    return { idle: null, reason: bounded(error instanceof Error ? error.message : String(error), 300) };
  }
}

/**
 * Prints, for each runtime, the applications a rollback deletes, and with `apply` deletes them, one runtime at a
 * time. Answers whether every runtime that has some was handled (or, without `apply`, listed).
 *
 * @param {{
 *   runtimes: () => Promise<Array<Record<string, unknown>>>;
 *   read: (args: readonly string[], options?: { accountId?: string }) => Promise<any>;
 *   remove: (applicationId: string, accountId: string) => Promise<void>;
 *   apply?: boolean;
 *   force?: boolean;
 *   now?: () => number;
 *   log?: (line: string) => void;
 * }} options
 */
export async function rollBackWorkspaceContainers({
  runtimes,
  read,
  remove,
  apply = false,
  force = false,
  now = () => Date.now(),
  log = (line) => console.log(line),
}) {
  let complete = true;
  const rows = await runtimes();
  log(apply ? 'Deleting the durable_object container applications:' : 'Dry run: nothing is deleted. Would delete:');
  for (const row of rows) {
    const workerName = String(row.worker_name ?? '');
    const accountId = String(row.account_id ?? '');
    const who = `${row.email ?? row.user_id}${row.organization ? ` (${row.organization})` : ''}`;
    if (!WORKER_NAME_PATTERN.test(workerName) || !accountId) {
      log(`- ${who}: skipped, its runtime record names no workspace Worker.`);
      complete = false;
      continue;
    }
    let applications;
    try {
      applications = runtimeApplications(await read(['containers', 'applications', 'list'], { accountId }), workerName);
    } catch (error) {
      log(
        `- ${who}, ${workerName}: its applications couldn't be listed: ${bounded(error instanceof Error ? error.message : error, 300)}`,
      );
      complete = false;
      continue;
    }
    if (applications.length === 0) {
      log(`- ${who}, ${workerName}: no durable_object applications, nothing to delete.`);
      continue;
    }
    const listed = applications.map((application) => `${application.name} (${application.id})`).join(', ');
    const activity = await readIdle(read, { workerName, accountId }, now());
    if (!apply) {
      const state = activity.idle === null ? `activity unreadable: ${activity.reason}` : activity.reason;
      log(
        `- ${who}, ${workerName}: ${listed}; ${activity.idle ? 'idle' : activity.idle === false ? 'busy' : 'unknown'}, ${state}.`,
      );
      continue;
    }
    if (activity.idle === false) {
      log(`- ${who}, ${workerName}: left alone, it is busy (${activity.reason}). Run it again once it is idle.`);
      complete = false;
      continue;
    }
    if (activity.idle === null && !force) {
      log(
        `- ${who}, ${workerName}: WARNING its activity can't be read (${activity.reason}), so it was left alone. ` +
          'Make sure nobody is using it and run again with --force.',
      );
      complete = false;
      continue;
    }
    if (activity.idle === null) {
      log(
        `- ${who}, ${workerName}: WARNING its activity can't be read (${activity.reason}); deleting anyway (--force).`,
      );
    }
    for (const application of applications) {
      try {
        await remove(application.id, accountId);
        log(`- ${who}, ${workerName}: deleted ${application.name} (${application.id}).`);
      } catch (error) {
        log(
          `- ${who}, ${workerName}: ${application.name} couldn't be deleted: ${bounded(error instanceof Error ? error.message : error, 300)}`,
        );
        complete = false;
        break;
      }
    }
  }
  return complete;
}

/**
 * The one change this script makes: `cf containers applications delete <id> --force` in the runtime's account,
 * for an id read from that account's own listing.
 * @param {{
 *   run?: (
 *     file: string,
 *     args: readonly string[],
 *     options: { encoding: 'utf8'; env: Record<string, string | undefined>; timeout: number },
 *   ) => Promise<{ stdout: string }>;
 *   env?: Record<string, string | undefined>;
 * }} [options]
 */
export function containerApplicationDeleter({ run = execFileAsync, env = process.env } = {}) {
  return async (applicationId, accountId) => {
    if (!APPLICATION_ID_PATTERN.test(applicationId)) {
      throw new Error('Refused an application id that is not one Cloudflare reports.');
    }
    const { stdout } = await run(
      'pnpm',
      ['exec', 'cf', 'containers', 'applications', 'delete', applicationId, '--force'],
      {
        encoding: 'utf8',
        env: { ...env, CF_SEND_TELEMETRY: 'false', CLOUDFLARE_ACCOUNT_ID: accountId },
        timeout: 120_000,
      },
    );
    const answer = extractJson(stdout);
    if (answer && answer.success === false) {
      throw new Error(bounded(JSON.stringify(answer.errors ?? answer), 300));
    }
  };
}

/** @param {readonly string[]} argv */
export function parseArguments(argv) {
  const known = new Set(['--dry-run', '--apply', '--force', '--help', '-h']);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    return { error: `Unknown option ${unknown[0]}.` };
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) {
    return { error: 'Choose --dry-run or --apply, not both.' };
  }
  if (argv.includes('--force') && !argv.includes('--apply')) {
    return { error: '--force only applies with --apply.' };
  }
  return { apply: argv.includes('--apply'), force: argv.includes('--force') };
}

async function main(argv) {
  const options = parseArguments(argv);
  if ('error' in options || 'help' in options) {
    console.log(options.error ? `${options.error}\n\n${USAGE}` : USAGE);
    return options.error ? 1 : 0;
  }
  const read = cfReader();
  const complete = await rollBackWorkspaceContainers({
    runtimes: async () => (await queryProduction(RUNTIMES_STATEMENT))[0] ?? [],
    read,
    remove: containerApplicationDeleter(),
    apply: options.apply,
    force: options.force,
  });
  return complete ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
