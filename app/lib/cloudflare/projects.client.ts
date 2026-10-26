import { z } from 'zod';
import { executeDataOperation, runtimeFailureSchema, UserRuntimeRequestError } from './client';
import { api, type ProjectCommit, type ProjectImportResult } from './data-api';
import { fetchUserRuntime } from './runtime-session';

/** Which project a history, clone or download names: one of the person's own chats, or a team project. */
export type ProjectRef = { chatInitialId: string } | { orgProjectId: string };

export const HISTORY_PAGE_SIZE = 30;

/** Importing copies the whole history of the source repository, which can take minutes for a large one: the
 * runtime's copy (`IMPORT_TIMEOUT_MS` in project-repository.ts, 30 minutes) plus its steps before and after. */
const IMPORT_TIMEOUT_MS = 35 * 60_000;
/** An upload sends the ZIP, then the runtime unpacks it and writes the project's first version. */
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
/** A fork copies the repository inside Artifacts and then seeds a new workspace from it. */
const FORK_TIMEOUT_MS = 2 * 60_000;

export function loadProjectHistory(ref: ProjectRef, offset: number, signal?: AbortSignal): Promise<ProjectCommit[]> {
  return executeDataOperation(api.projects.history, { ...ref, limit: HISTORY_PAGE_SIZE, offset }, { signal });
}

export function loadCloneAccess(ref: ProjectRef) {
  return executeDataOperation(api.projects.cloneAccess, ref);
}

export function forkProject(chatInitialId: string, commit: string) {
  return executeDataOperation(api.projects.fork, { chatInitialId, commit }, { timeoutMs: FORK_TIMEOUT_MS });
}

export function importProject(args: { url: string; name?: string }) {
  return executeDataOperation(api.projects.import, args, { timeoutMs: IMPORT_TIMEOUT_MS });
}

/** Makes a new project from a ZIP of its code: the workspace runtime unpacks it into the project's first version. */
export async function uploadProject(file: Blob, name: string): Promise<ProjectImportResult> {
  const response = await fetchUserRuntime(`/v1/projects/upload?${new URLSearchParams({ name })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: file,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = runtimeFailureSchema.safeParse(body);
    throw new UserRuntimeRequestError(
      (failure.success ? failure.data.error : undefined) ?? 'The ZIP could not be uploaded. Try again.',
      response.status,
      failure.success ? failure.data.retryable : undefined,
    );
  }
  return uploadedSchema.parse(body);
}

const uploadedSchema = z.object({ projectId: z.string(), initialId: z.string() });

/** What a runtime route answers before the workspace runtime has been upgraded to have it. */
const WORKSPACE_UPDATING = 'Your workspace is being updated. Try again in a few minutes.';

async function runtimeFailure(response: Response, fallback: string): Promise<UserRuntimeRequestError> {
  if (response.status === 404) {
    return new UserRuntimeRequestError(WORKSPACE_UPDATING, response.status, true);
  }
  const failure = runtimeFailureSchema.safeParse(await response.json().catch(() => null));
  return new UserRuntimeRequestError(
    (failure.success ? failure.data.error : undefined) ?? fallback,
    response.status,
    failure.success ? failure.data.retryable : undefined,
  );
}

/** Publishes a team project again after its publish `deploymentId` failed. Answers the new publish's id. */
export async function retryProjectDeploy(
  orgProjectId: string,
  deploymentId: string,
  options: { toWantedWorker?: true } = {},
): Promise<string> {
  const response = await fetchUserRuntime('/v1/projects/deploy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgProjectId, deploymentId, ...options }),
  });
  if (!response.ok) {
    throw await runtimeFailure(response, 'It could not be published again. Try again.');
  }
  return retriedSchema.parse(await response.json()).deploymentId;
}

const retriedSchema = z.object({ deploymentId: z.string() });

/** The last part of what happened while a team project's publish ran, as plain text. */
export async function loadProjectDeployLog(
  orgProjectId: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<string> {
  const query = new URLSearchParams({ project: orgProjectId, deployment: deploymentId });
  const response = await fetchUserRuntime(`/v1/projects/deploy-log?${query}`, { signal });
  if (!response.ok) {
    throw await runtimeFailure(response, 'What happened could not be loaded. Try again.');
  }
  return response.text();
}

/** The first line of a commit message, which is its title. */
export function commitTitle(message: string): string {
  return message.split('\n', 1)[0]?.trim() || 'No message';
}

export function shortCommit(hash: string): string {
  return hash.slice(0, 7);
}

/**
 * Downloads the project's files at `commit` (the newest commit on `main` when it's left out) as a ZIP the
 * workspace runtime builds from the repository.
 */
export async function downloadProjectArchive(ref: ProjectRef, fallbackName: string, commit?: string): Promise<void> {
  const query = new URLSearchParams(
    'chatInitialId' in ref ? { chat: ref.chatInitialId } : { project: ref.orgProjectId },
  );
  if (commit) {
    query.set('ref', commit);
  }
  const response = await fetchUserRuntime(`/v1/projects/archive?${query}`);
  if (!response.ok) {
    const body = runtimeFailureSchema.safeParse(await response.json().catch(() => null));
    throw new UserRuntimeRequestError(
      (body.success ? body.data.error : undefined) ?? 'The ZIP could not be downloaded. Try again.',
      response.status,
      body.success ? body.data.retryable : undefined,
    );
  }
  const archive = await response.blob();
  const name =
    attachmentName(response.headers.get('Content-Disposition')) ??
    `${fallbackName}${commit ? `-${shortCommit(commit)}` : ''}.zip`;
  const url = URL.createObjectURL(archive);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The click has handed the blob to the browser's download; the object URL can go on the next turn.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function attachmentName(disposition: string | null): string | null {
  const match = disposition?.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? null;
}

/** Opens a project's chat with a full page load, which starts its workspace afresh. */
export function openProjectChat(initialId: string): void {
  window.location.assign(`/chat/${encodeURIComponent(initialId)}`);
}
