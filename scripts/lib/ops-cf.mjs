/**
 * What `pnpm run ops` and `pnpm run ops:session` share: reading production through the operator's own `cf`
 * login, with every command checked against a read-only allowlist before a process starts.
 */
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { controlPlaneDatabaseId, loadCommittedWranglerConfig } from './cloudflare-config.mjs';

export const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** The only `cf` commands the ops scripts run. Each one reads. */
const READ_ONLY_CF_COMMANDS = Object.freeze([
  'd1 query',
  'd1 list',
  'o11y telemetry query',
  'ai models list',
  'ai-gateway logs list',
  'ai-gateway logs get-request',
  'ai-gateway logs get-response',
  'builds list',
]);

/**
 * @typedef {(args: readonly string[], options?: { accountId?: string }) => Promise<any>} CfReader
 */

/**
 * The `--body` of a command shaped `<command> <positional?> --body <json>`, and nothing else: a second flag beside
 * the checked body could carry a write of its own.
 * @param {readonly string[]} args
 * @param {number} bodyAt where `--body` must stand
 */
function onlyBody(args, bodyAt) {
  if (args.length !== bodyAt + 2 || args[bodyAt] !== '--body') {
    return null;
  }
  try {
    return JSON.parse(args[bodyAt + 1]);
  } catch {
    return null;
  }
}

/** Refuse anything but a read: a misuse of an ops script must never change production. */
export function assertReadOnlyCf(args) {
  const command = READ_ONLY_CF_COMMANDS.find((name) => args.slice(0, name.split(' ').length).join(' ') === name);
  if (!command) {
    throw new Error(`The ops scripts run only read-only cf commands; refused \`cf ${args.slice(0, 3).join(' ')}\`.`);
  }
  if (command === 'd1 query') {
    const sql = String(onlyBody(args, 3)?.sql ?? '');
    const statements = sql.split(';').filter((statement) => statement.trim().length > 0);
    if (statements.length === 0 || !statements.every((statement) => /^\s*SELECT\b/i.test(statement))) {
      throw new Error('The ops scripts issue only SELECT statements, passed as a query body.');
    }
  }
  if (command === 'o11y telemetry query' && onlyBody(args, 3)?.dry !== true) {
    throw new Error('The ops scripts issue only dry-run Workers Logs queries, which save nothing.');
  }
}

/** Collapse whitespace and bound a provider string before it reaches a terminal. */
export function bounded(value, limit = 240) {
  return String(value ?? '')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * Run one read and record why it failed instead of letting the failure look like emptiness.
 * @template T
 * @param {() => Promise<T> | T} read
 * @param {{ limit?: number }} [options] bound the recorded reason to this many characters
 */
export async function attempt(read, { limit } = {}) {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: limit === undefined ? reason : bounded(reason, limit) };
  }
}

/**
 * Turn a failed `cf` or `gh` command into the sentence an operator can act on. `cf` reports a failure as a boxed
 * block on stderr (`┌ APIError`, `│ [7500] no such table: …`, `└`); the box lines carry the reason and everything
 * else is pnpm's own wrapper noise.
 * @param {string} command the program that failed, named when it left no reason
 */
function describeCommandFailure(error, command) {
  const stderr = String(error?.stderr ?? '');
  const boxed = stderr
    .split('\n')
    .filter((line) => line.startsWith('│'))
    .map((line) => line.slice(1).trim())
    .filter(Boolean);
  if (boxed.length > 0) {
    return bounded(boxed.join(' '), 400);
  }
  return bounded(stderr || error?.message || `${command} produced no output.`, 400);
}

/** A CLI may prefix its JSON with a blank line or a banner. */
export function extractJson(output) {
  const text = String(output ?? '');
  const start = text.search(/[[{]/);
  if (start < 0) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

/**
 * The real `cf` reader: the operator's own login, telemetry off, and an account selected when one is named. Without
 * one, `cf` resolves the account itself, from `CLOUDFLARE_ACCOUNT_ID` or the single account the login can see, so
 * the ops scripts hold no account or credential of their own.
 * @param {{ run?: typeof execFileAsync; env?: Record<string, string | undefined> }} [options]
 * @returns {CfReader}
 */
export function cfReader({ run = execFileAsync, env = process.env } = {}) {
  return async (args, { accountId } = {}) => {
    assertReadOnlyCf(args);
    // cf reports usage unless told not to; a read-only report must not phone home.
    const commandEnv = { ...env, CF_SEND_TELEMETRY: 'false' };
    if (accountId) {
      commandEnv.CLOUDFLARE_ACCOUNT_ID = accountId;
    }
    let stdout;
    try {
      ({ stdout } = await run('pnpm', ['exec', 'cf', ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        env: commandEnv,
        maxBuffer: 256 * 1024 * 1024,
        timeout: 120_000,
      }));
    } catch (error) {
      throw new Error(describeCommandFailure(error, 'cf'));
    }
    const parsed = extractJson(stdout);
    if (parsed === null) {
      throw new Error(`\`cf ${args.slice(0, 3).join(' ')}\` did not return JSON: ${bounded(stdout, 200)}`);
    }
    return parsed;
  };
}

/** The control-plane database's id, as the committed cloudflare.config.ts binds it. */
export async function resolveControlPlaneDatabaseId() {
  return controlPlaneDatabaseId(await loadCommittedWranglerConfig());
}
