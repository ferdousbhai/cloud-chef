import { z } from 'zod';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import type { CloudflareApiRuntimeIdentity } from './cloudflare-api-runtime-controls';
import { runtimeCredentialEndpoint } from './user-workspace-cloudflare-credential';

/**
 * A workspace runtime's side of working on an organization's GitHub project: it never holds a GitHub
 * token, so every read and write goes through the control plane, which checks access on each call.
 */
const SNAPSHOT_TIMEOUT_MS = 5 * 60_000;
const COMMIT_TIMEOUT_MS = 2 * 60_000;
const STATUS_TIMEOUT_MS = 30_000;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024;

type RuntimeEnv = Pick<Env, 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT' | 'CONTROL_PLANE_SECRET'>;
type Identity = Pick<CloudflareApiRuntimeIdentity, 'userId' | 'connectionId' | 'connectionGeneration'>;

const snapshotLineSchema = z.union([
  z.object({ commit: z.string(), defaultBranch: z.string(), repository: z.string() }),
  z.object({ path: z.string(), contentBase64: z.string(), executable: z.boolean(), blobSha: z.string() }),
  z.object({ done: z.literal(true), files: z.number() }),
  z.object({ error: z.string() }),
]);
export type LinkedSnapshotLine = z.infer<typeof snapshotLineSchema>;

const commitResultSchema = z.object({
  commit: z.string(),
  branch: z.string(),
  published: z.string().optional(),
  code: z.string().optional(),
  error: z.string().optional(),
});
type LinkedCommitResult = z.infer<typeof commitResultSchema>;

const buildStatusSchema = z.object({
  state: z.enum(['pending', 'success', 'failure', 'none']),
  previewUrl: z.string().nullable(),
  detailsUrl: z.string().nullable(),
});
export type LinkedBuildStatus = z.infer<typeof buildStatusSchema>;

const errorSchema = z.object({ error: z.string() });

/** A project's default branch, file by file, as the control plane streams it. */
export async function* streamLinkedProjectSnapshot(
  env: RuntimeEnv,
  identity: Identity,
  orgProjectId: string,
): AsyncGenerator<LinkedSnapshotLine> {
  const response = await post(env, 'runtime-github/snapshot', { ...pick(identity), orgProjectId }, SNAPSHOT_TIMEOUT_MS);
  if (!response.ok || !response.body) {
    throw new Error(await failureMessage(response, 'CloudChef could not read the project from GitHub.'));
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    buffered += next.value;
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim()) {
        yield snapshotLineSchema.parse(JSON.parse(line));
      }
      newline = buffered.indexOf('\n');
    }
  }
}

/** Commits changes to the member's branch, and with `publish` merges it into the default branch. */
export async function commitLinkedProject(
  env: RuntimeEnv,
  identity: Identity,
  body: {
    orgProjectId: string;
    baseCommit: string;
    message: string;
    publish: boolean;
    changes: { path: string; contentBase64: string | null; executable: boolean }[];
  },
): Promise<LinkedCommitResult> {
  const response = await post(env, 'runtime-github/commit', { ...pick(identity), ...body }, COMMIT_TIMEOUT_MS);
  if (!response.ok && response.status !== 409) {
    throw new Error(await failureMessage(response, 'CloudChef could not commit to GitHub.'));
  }
  return commitResultSchema.parse(
    await readJsonBodyWithLimit(response, MAX_JSON_RESPONSE_BYTES, 'Linked project commit response'),
  );
}

/** What the repository's pipeline reports for a commit so far. */
export async function linkedBuildStatus(
  env: RuntimeEnv,
  identity: Identity,
  orgProjectId: string,
  sha: string,
): Promise<LinkedBuildStatus> {
  const response = await post(
    env,
    'runtime-github/status',
    { ...pick(identity), orgProjectId, sha },
    STATUS_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(await failureMessage(response, 'CloudChef could not read the build status.'));
  }
  return buildStatusSchema.parse(
    await readJsonBodyWithLimit(response, MAX_JSON_RESPONSE_BYTES, 'Linked project status response'),
  );
}

function pick(identity: Identity) {
  return {
    userId: identity.userId,
    connectionId: identity.connectionId,
    connectionGeneration: identity.connectionGeneration,
  };
}

function post(
  env: RuntimeEnv,
  route: 'runtime-github/snapshot' | 'runtime-github/commit' | 'runtime-github/status',
  body: Record<
    string,
    string | number | boolean | { path: string; contentBase64: string | null; executable: boolean }[]
  >,
  timeoutMs: number,
): Promise<Response> {
  return fetch(runtimeCredentialEndpoint(env.CLOUDCHEF_CONTROL_PLANE_ENDPOINT, route), {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CONTROL_PLANE_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function failureMessage(response: Response, fallback: string): Promise<string> {
  const parsed = errorSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.error : fallback;
}
