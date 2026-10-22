import { z } from 'zod';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import type { RuntimeConnectionIdentity } from './cloudflare-api-runtime-identity';
import { postRuntimeRoute, type RuntimeFileChange } from './user-workspace-cloudflare-credential';

/**
 * A workspace runtime's side of working on an organization's GitHub project: it never holds a GitHub
 * token, so every read and write goes through the control plane, which checks access on each call.
 */
const SNAPSHOT_TIMEOUT_MS = 5 * 60_000;
const COMMIT_TIMEOUT_MS = 2 * 60_000;
const STATUS_TIMEOUT_MS = 30_000;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024;

type RuntimeEnv = Pick<Env, 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT' | 'CONTROL_PLANE_SECRET'>;
type Identity = Pick<RuntimeConnectionIdentity, 'userId' | 'connectionId' | 'connectionGeneration'>;

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
  conclusion: z.string().nullable(),
  /** Whether the commit has Workers Builds' own check runs, not only other CI. */
  workersBuilds: z.boolean(),
});
export type LinkedBuildStatus = z.infer<typeof buildStatusSchema>;

const siteOriginsSchema = z.object({ origins: z.array(z.string()).max(16) });

const productionRequestSentSchema = z.object({ outcome: z.enum(['requested', 'updated', 'unchanged']) });

const errorSchema = z.object({ error: z.string() });

/** A project's default branch, file by file, as the control plane streams it. */
export async function* streamLinkedProjectSnapshot(
  env: RuntimeEnv,
  identity: Identity,
  orgProjectId: string,
): AsyncGenerator<LinkedSnapshotLine> {
  const response = await postRuntimeRoute(
    env,
    identity,
    'runtime-github/snapshot',
    { orgProjectId },
    SNAPSHOT_TIMEOUT_MS,
  );
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

/** Commits changes to the workspace's branch, and with `publish` merges it into the default branch. */
export async function commitLinkedProject(
  env: RuntimeEnv,
  identity: Identity,
  body: {
    orgProjectId: string;
    /** The workspace's own branch; without it, the member's one branch. */
    branchKey?: string;
    baseCommit: string;
    message: string;
    publish: boolean;
    changes: RuntimeFileChange[];
  },
): Promise<LinkedCommitResult> {
  const response = await postRuntimeRoute(env, identity, 'runtime-github/commit', body, COMMIT_TIMEOUT_MS);
  const payload = await readJsonBodyWithLimit(
    response,
    MAX_JSON_RESPONSE_BYTES,
    'Linked project commit response',
  ).catch(() => null);
  const result = commitResultSchema.safeParse(payload);
  // A 409 is a result only when it's an overlap with newer work; anything else is a refusal to explain.
  if (result.success && (response.ok || (response.status === 409 && result.data.code === 'merge_conflict'))) {
    return result.data;
  }
  const refused = errorSchema.safeParse(payload);
  throw new Error(refused.success ? refused.data.error : 'CloudChef could not commit to GitHub.');
}

/** What the repository's pipeline reports for a commit so far. */
export async function linkedBuildStatus(
  env: RuntimeEnv,
  identity: Identity,
  orgProjectId: string,
  sha: string,
): Promise<LinkedBuildStatus> {
  const response = await postRuntimeRoute(
    env,
    identity,
    'runtime-github/status',
    { orgProjectId, sha },
    STATUS_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(await failureMessage(response, 'CloudChef could not read the build status.'));
  }
  return buildStatusSchema.parse(
    await readJsonBodyWithLimit(response, MAX_JSON_RESPONSE_BYTES, 'Linked project status response'),
  );
}

/**
 * The project's live site, as the https origins the control plane reports for it: the repository's
 * homepage on GitHub and the preview links its pipeline posted for the default branch and this member's.
 */
export async function linkedSiteOrigins(
  env: RuntimeEnv,
  identity: Identity,
  orgProjectId: string,
  branchKey: string | undefined,
): Promise<string[]> {
  const response = await postRuntimeRoute(
    env,
    identity,
    'runtime-github/site',
    { orgProjectId, branchKey },
    STATUS_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(await failureMessage(response, "CloudChef could not look up the project's site."));
  }
  return siteOriginsSchema.parse(
    await readJsonBodyWithLimit(response, MAX_JSON_RESPONSE_BYTES, 'Linked project site response'),
  ).origins;
}

/** Whether the admins now see a new request, this draft's request updated to the revision sent, or no change. */
export type ProductionRequestOutcome = z.infer<typeof productionRequestSentSchema>['outcome'];

/** Asks the organization's admins to make a draft a real project; its files travel with the request. */
export async function requestProductionReview(
  env: RuntimeEnv,
  identity: Identity,
  body: {
    draftId: string;
    draftRevision: string;
    title: string;
    note: string;
    previewUrl: string | null;
    snapshot: string;
    files: number;
  },
): Promise<{ outcome: ProductionRequestOutcome }> {
  const response = await postRuntimeRoute(env, identity, 'runtime-github/request-production', body, COMMIT_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(await failureMessage(response, 'CloudChef could not send the request.'));
  }
  return productionRequestSentSchema.parse(
    await readJsonBodyWithLimit(response, MAX_JSON_RESPONSE_BYTES, 'Production request response'),
  );
}

async function failureMessage(response: Response, fallback: string): Promise<string> {
  const parsed = errorSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.error : fallback;
}
