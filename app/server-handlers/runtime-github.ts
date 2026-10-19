import { z } from 'zod';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';
import { GitHubError } from '~/lib/.server/github/github-api';
import { gitHubAppFromEnv, type GitHubApp } from '~/lib/.server/github/github-app';
import type { RepositoryClient } from '~/lib/.server/github/repository-client';
import { readRepositoryTarball } from '~/lib/.server/github/tarball';
import { bytesToBase64, bytesToHex } from '~/lib/hex-digest';
import { findAccessibleProject, findGitHubInstallation } from '~/lib/cloudflare/data/org-projects.server';
import { authenticateRuntime } from './runtime-credential';

/**
 * A member's workspace runtime working on an organization's GitHub project. The runtime never holds a
 * GitHub token: it asks the control plane, which checks the runtime's identity and the member's access to
 * the project on every call, and mints a token limited to that one repository for that one operation.
 */
const MAX_SNAPSHOT_REQUEST_BYTES = 4 * 1024;
const MAX_COMMIT_REQUEST_BYTES = 48 * 1024 * 1024;
/** The workspace's own limits (user-workspace-runtime/src/protocol.ts). */
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const identityFields = {
  userId: z.string().min(1).max(512),
  connectionId: z.string().min(1).max(512),
  connectionGeneration: z.number().int().positive(),
  orgProjectId: z.string().uuid(),
};
const snapshotSchema = z.strictObject(identityFields);
const commitSchema = z.strictObject({
  ...identityFields,
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
  message: z.string().trim().min(1).max(2_000),
  changes: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1_024),
        contentBase64: z.string().nullable(),
        executable: z.boolean(),
      }),
    )
    .min(1)
    .max(MAX_FILES),
  /** Also merge into the default branch, which the repository's pipeline deploys. */
  publish: z.boolean(),
});
const statusSchema = z.strictObject({ ...identityFields, sha: z.string().regex(/^[0-9a-f]{40}$/) });
const MAX_SNAPSHOT_BASE64 = 1_500_000;
const MAX_PENDING_REQUESTS_PER_MEMBER = 5;
const productionRequestSchema = z.strictObject({
  userId: identityFields.userId,
  connectionId: identityFields.connectionId,
  connectionGeneration: identityFields.connectionGeneration,
  title: z.string().trim().min(1).max(80),
  note: z.string().trim().max(1_000),
  previewUrl: z.url().max(2_048).nullable(),
  /** The draft's files as gzipped JSON `[{ path, contentBase64, executable }]`, base64. */
  snapshot: z.string().min(1).max(MAX_SNAPSHOT_BASE64),
  files: z.number().int().min(1).max(MAX_FILES),
});

type ProjectAccess = { repository: RepositoryClient; defaultBranch: string; userId: string };

/**
 * The project's default branch as files, streamed as newline-delimited JSON: a `commit` line, one line per
 * file (base64 content and its git blob SHA, so the runtime can tell later what changed), then `done`.
 */
export async function runtimeGitHubSnapshotAction(args: {
  request: Request;
  env: Env;
  app?: GitHubApp | null;
}): Promise<Response> {
  const body = await readBody(args.request, snapshotSchema, MAX_SNAPSHOT_REQUEST_BYTES);
  if (body instanceof Response) {
    return body;
  }
  const access = await openProject(args, body, { contents: 'read' });
  if (access instanceof Response) {
    return access;
  }
  const commit = await access.repository.branchHead(access.defaultBranch);
  if (!commit) {
    return json({ error: `The repository has no ${access.defaultBranch} branch.` }, 409);
  }
  const tarball = await access.repository.tarball(commit);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const line = (value: JsonBody) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      line({ commit, defaultBranch: access.defaultBranch, repository: access.repository.fullName });
      let files = 0;
      let total = 0;
      try {
        for await (const entry of readRepositoryTarball(tarball)) {
          files += 1;
          total += entry.bytes.length;
          if (files > MAX_FILES || entry.bytes.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
            line({ error: 'This repository is larger than a CloudChef workspace holds (10,000 files, 64 MB).' });
            controller.close();
            return;
          }
          line({
            path: entry.path,
            contentBase64: bytesToBase64(entry.bytes),
            executable: entry.executable,
            blobSha: await gitBlobSha(entry.bytes),
          });
        }
        line({ done: true, files });
      } catch {
        line({ error: 'The repository download failed. Try again.' });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
}

/**
 * Commits the workspace's changes, relative to the commit it was opened from, to the member's own
 * branch (`cloudchef/<name>`): one commit on top of that base, replacing the branch's last one, so the
 * branch always shows exactly the workspace. With `publish`, the branch is then merged into the default
 * branch, which the repository's pipeline deploys.
 */
export async function runtimeGitHubCommitAction(args: {
  request: Request;
  env: Env;
  app?: GitHubApp | null;
}): Promise<Response> {
  const body = await readBody(args.request, commitSchema, MAX_COMMIT_REQUEST_BYTES);
  if (body instanceof Response) {
    return body;
  }
  const access = await openProject(args, body, { contents: 'write' });
  if (access instanceof Response) {
    return access;
  }
  try {
    const branch = await memberBranch(args.env.DB, access.userId);
    const branchHead = await access.repository.branchHead(branch);
    const commit = await access.repository.commit({
      branch,
      parent: body.baseCommit,
      baseTree: await access.repository.commitTree(body.baseCommit),
      message: body.message,
      changes: body.changes,
      branchExists: branchHead !== null,
    });
    if (!body.publish) {
      return json({ commit, branch }, 200);
    }
    const merged = await access.repository.merge(
      access.defaultBranch,
      branch,
      `Publish from CloudChef: ${body.message.split('\n')[0]}`,
    );
    if (merged.status === 'conflict') {
      return json(
        {
          code: 'merge_conflict',
          commit,
          branch,
          error: `${access.defaultBranch} changed since this workspace was opened, and the changes overlap.`,
        },
        409,
      );
    }
    return json({ commit, branch, published: merged.status === 'merged' ? merged.sha : commit }, 200);
  } catch (error) {
    if (error instanceof GitHubError) {
      return gitHubFailure(error);
    }
    throw error;
  }
}

/** What the repository's pipeline reports for a commit: building, built (with its preview link), failed. */
export async function runtimeGitHubStatusAction(args: {
  request: Request;
  env: Env;
  app?: GitHubApp | null;
}): Promise<Response> {
  const body = await readBody(args.request, statusSchema, MAX_SNAPSHOT_REQUEST_BYTES);
  if (body instanceof Response) {
    return body;
  }
  const access = await openProject(args, body, { checks: 'read' });
  if (access instanceof Response) {
    return access;
  }
  try {
    return json(await access.repository.buildStatus(body.sha), 200);
  } catch (error) {
    if (error instanceof GitHubError) {
      return gitHubFailure(error);
    }
    throw error;
  }
}

/**
 * A member asking for a draft built in the organization's account to become a real project: an admin
 * reviews it and, approving, creates its GitHub repository. The draft's source comes with the request.
 */
export async function runtimeRequestProductionAction(args: { request: Request; env: Env }): Promise<Response> {
  const body = await readBody(args.request, productionRequestSchema, MAX_SNAPSHOT_BASE64 + 8 * 1024);
  if (body instanceof Response) {
    return body;
  }
  const authenticated = await authenticateRuntime(args.env, args.request, body);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const orgId = authenticated.connection.orgId;
  if (!orgId) {
    return json({ error: "Production requests are for an organization's drafts." }, 409);
  }
  const pending = await args.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM production_requests WHERE requested_by = ? AND org_id = ? AND status = 'pending'`,
  )
    .bind(body.userId, orgId)
    .first<{ count: number }>();
  if ((pending?.count ?? 0) >= MAX_PENDING_REQUESTS_PER_MEMBER) {
    return json({ error: 'You already have several requests waiting. An admin will get to them.' }, 429);
  }
  const id = crypto.randomUUID();
  await args.env.DB.prepare(
    `INSERT INTO production_requests
       (id, org_id, requested_by, title, note, preview_url, snapshot_gzip_base64, snapshot_files, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(id, orgId, body.userId, body.title, body.note || null, body.previewUrl, body.snapshot, body.files, Date.now())
    .run();
  return json({ requestId: id }, 201);
}

/**
 * The project, if this runtime may work on it: the runtime proves who it is, the member may still work
 * on the project, and the project belongs to the organization whose account the runtime runs in.
 */
async function openProject(
  args: { request: Request; env: Env; app?: GitHubApp | null },
  identity: z.infer<typeof snapshotSchema>,
  permissions: { contents?: 'read' | 'write'; checks?: 'read' },
): Promise<ProjectAccess | Response> {
  const authenticated = await authenticateRuntime(args.env, args.request, identity);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const project = await findAccessibleProject(args.env.DB, identity.orgProjectId, identity.userId);
  if (!project || project.orgId !== authenticated.connection.orgId) {
    return json({ error: 'This project is not available to you.' }, 403);
  }
  const app = args.app === undefined ? gitHubAppFromEnv(args.env) : args.app;
  const installation = await findGitHubInstallation(args.env.DB, project.orgId);
  if (!app || !installation) {
    return json({ error: "The organization's GitHub isn't connected. Ask an admin to connect it." }, 409);
  }
  try {
    return {
      repository: await app.repository(
        installation.installationId,
        { id: project.repoId, fullName: project.repoFullName },
        permissions,
      ),
      defaultBranch: project.defaultBranch,
      userId: identity.userId,
    };
  } catch (error) {
    if (error instanceof GitHubError) {
      return gitHubFailure(error);
    }
    throw error;
  }
}

/** The member's own branch: their email's name part, made safe for git. */
async function memberBranch(db: D1Database, userId: string): Promise<string> {
  const user = await db.prepare('SELECT email FROM "user" WHERE id = ?').bind(userId).first<{ email: string }>();
  const name = (user?.email.split('@')[0] ?? 'member')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `cloudchef/${name || 'member'}-${userId
    .slice(0, 6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '0')}`;
}

/** Git's object id for file contents: SHA-1 of `blob <size>\0<bytes>`. */
async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  return bytesToHex(await crypto.subtle.digest('SHA-1', object));
}

async function readBody<T>(request: Request, schema: z.ZodType<T>, limit: number): Promise<T | Response> {
  try {
    return schema.parse(await readJsonBodyWithLimit(request, limit, 'Workspace runtime GitHub request'));
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return json({ error: error.message }, 413);
    }
    if (error instanceof InvalidJsonBodyError || error instanceof z.ZodError) {
      return json({ error: 'Invalid workspace runtime GitHub request.' }, 400);
    }
    throw error;
  }
}

function gitHubFailure(error: GitHubError): Response {
  return json({ error: error.message }, error.status === 404 ? 404 : 502);
}

/** A JSON answer to the runtime: flat records only. */
type JsonBody = Record<string, string | number | boolean | null>;

function json(body: JsonBody, status: number): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
