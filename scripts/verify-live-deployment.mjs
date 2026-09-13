import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const VERSION_URL = 'https://ghostbuild.dev/api/version';
const DEFAULT_STABILIZATION_MS = 60_000;
const DEFAULT_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_CONSECUTIVE_CHECKS = 5;
const DEFAULT_MAX_LOCAL_ATTEMPTS = 15;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

function headerValue(headers, name) {
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(', ') : (value ?? null);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function validateExpectedSha(value) {
  if (typeof value !== 'string' || !COMMIT_SHA_PATTERN.test(value)) {
    throw new Error('EXPECTED_SHA must be the exact lowercase 40-hex Git commit ID.');
  }
  return value;
}

export function versionResponseErrors({ statusCode, headers, body, expectedSha }) {
  const errors = [];
  if (statusCode !== 200) {
    errors.push(`expected HTTP 200, received ${statusCode ?? 'no status'}`);
  }
  if (body?.sha !== expectedSha) {
    errors.push(`expected SHA ${expectedSha}, received ${body?.sha ?? '<empty>'}`);
  }
  if (typeof body?.versionId !== 'string' || body.versionId.length === 0) {
    errors.push('missing Worker version ID');
  }
  if (body?.oauthConfigured !== true) {
    errors.push('Cloudflare OAuth bindings are incomplete');
  }
  const cacheControl = headerValue(headers, 'cache-control') ?? '';
  if (
    !cacheControl
      .toLowerCase()
      .split(',')
      .some((directive) => directive.trim() === 'no-store')
  ) {
    errors.push(`expected Cache-Control: no-store, received ${cacheControl || '<empty>'}`);
  }
  return errors;
}

function probeSummary({ label, statusCode, headers, body, errors }) {
  const cfRay = headerValue(headers, 'cf-ray') ?? '<missing>';
  const sha = body?.sha ?? '<empty>';
  const versionId = body?.versionId ?? '<empty>';
  const oauthConfigured = body?.oauthConfigured === true ? 'ready' : 'incomplete';
  const outcome = errors.length === 0 ? 'ok' : errors.join('; ');
  return `${label}: ${outcome}; status=${statusCode ?? '<empty>'}; sha=${sha}; version=${versionId}; oauth=${oauthConfigured}; cf-ray=${cfRay}`;
}

async function fetchVersion(expectedSha, attempt, fetchImplementation) {
  const url = new URL(VERSION_URL);
  url.searchParams.set('deployment-check', `${expectedSha}-${attempt}-${Date.now()}`);
  const response = await fetchImplementation(url, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(20_000),
  });
  const rawBody = await response.text();
  return {
    statusCode: response.status,
    headers: response.headers,
    body: parseJson(rawBody),
  };
}

/**
 * @param {{
 *   expectedSha?: string;
 *   fetchImplementation?: typeof fetch;
 *   stabilizationMs?: number;
 *   checkIntervalMs?: number;
 *   consecutiveChecks?: number;
 *   maxAttempts?: number;
 *   waitImplementation?: (delayMs: number) => Promise<unknown>;
 *   log?: (message: string) => void;
 * }} [options]
 */
export async function verifyLocalDeployment({
  expectedSha,
  fetchImplementation = fetch,
  stabilizationMs = DEFAULT_STABILIZATION_MS,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  consecutiveChecks = DEFAULT_CONSECUTIVE_CHECKS,
  maxAttempts = DEFAULT_MAX_LOCAL_ATTEMPTS,
  waitImplementation = wait,
  log = console.log,
} = {}) {
  expectedSha = validateExpectedSha(expectedSha);

  log(`Waiting ${stabilizationMs / 1000}s for Worker routing to stabilize.`);
  await waitImplementation(stabilizationMs);

  let consecutiveSuccesses = 0;
  let lastErrors = ['no probes completed'];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const probe = await fetchVersion(expectedSha, attempt, fetchImplementation);
      lastErrors = versionResponseErrors({ ...probe, expectedSha });
      log(probeSummary({ label: `Direct probe ${attempt}`, ...probe, errors: lastErrors }));
      consecutiveSuccesses = lastErrors.length === 0 ? consecutiveSuccesses + 1 : 0;
      if (consecutiveSuccesses >= consecutiveChecks) {
        return;
      }
    } catch (error) {
      consecutiveSuccesses = 0;
      lastErrors = [error instanceof Error ? error.message : String(error)];
      log(`Direct probe ${attempt}: ${lastErrors[0]}`);
    }
    if (attempt < maxAttempts) {
      await waitImplementation(checkIntervalMs);
    }
  }

  throw new Error(
    `Production did not return the expected version for ${consecutiveChecks} consecutive checks: ${lastErrors.join('; ')}`,
  );
}

async function main() {
  await verifyLocalDeployment({ expectedSha: process.env.EXPECTED_SHA });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
