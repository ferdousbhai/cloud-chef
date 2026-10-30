import { z } from 'zod';
import { findAccessibleProject } from '~/lib/cloudflare/data/org-projects.server';
import {
  findManagedPostOfProject,
  replaceReel,
  ShowcaseError,
  type NewMedia,
} from '~/lib/cloudflare/data/posts.server';
import { classifyMedia } from '~/lib/.server/showcase/screenshot';
import { deleteGoneMediaBestEffort, mediaKey } from '~/lib/.server/showcase/media';
import { base64ToBytes } from '~/lib/hex-digest';
import { REEL_LIMITS, reelBundleSchema, reelRefContentType, reelRefs, reelSeconds, renameReelRefs } from '~/lib/reel';
import { reelFilesProblem, stillInfo } from '~/lib/reel-files';
import { readAuthenticatedRuntimeRequest } from './runtime-authentication';

/**
 * A post's clip, from the workspace runtime of the person whose post it is (app/lib/reel.ts). The agent makes a clip in
 * the person's workspace and shows it in the chat; the runtime asks here first which post it would go on, and sends it
 * only once the person pressed Approve there. Nothing the runtime says is trusted: who may change the post is checked
 * here (its author, or a team project's admin), and the timeline and every file are checked again before anything is
 * kept in CloudChef's R2.
 */

/** A clip's JSON: its files base64-encoded, a third larger than their limit, and its timeline. */
const MAX_REEL_REQUEST_BYTES = Math.ceil((REEL_LIMITS.totalBytes * 4) / 3) + 64 * 1024;
const MAX_TARGET_REQUEST_BYTES = 8 * 1024;
const PROJECT = z.string().uuid();

const NO_POST =
  'This project has no post to put a clip on: only a public project that has been published has one, and only its author or a team’s admin can add a clip.';

function json<Answer>(body: Answer, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** The post a person may put a clip on, for the project their runtime works on; null when there is none. */
async function managedPost(env: Env, projectId: string, userId: string, connectionId: string) {
  const project = await findAccessibleProject(env.DB, projectId, userId);
  if (!project || project.connectionId !== connectionId) {
    return null;
  }
  return findManagedPostOfProject(env.DB, projectId, userId);
}

/** `POST /api/cloudflare/runtime-projects/reel/target`: the post a clip of this project would go on. */
export async function runtimeReelTargetAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(env, request, z.strictObject({ orgProjectId: PROJECT }), {
    maxBytes: MAX_TARGET_REQUEST_BYTES,
    label: 'Clip target request',
    invalid: 'Invalid clip request.',
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { body, identity, connection } = authenticated;
  const post = await managedPost(env, body.orgProjectId, identity.userId, connection.id);
  return post ? json({ postId: post.id, path: post.path, title: post.title }) : json({ error: NO_POST }, 409);
}

/** `POST /api/cloudflare/runtime-projects/reel`: a clip its author approved in the chat, onto their post. */
export async function runtimeReelAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(
    env,
    request,
    z.strictObject({ orgProjectId: PROJECT, reel: reelBundleSchema }),
    { maxBytes: MAX_REEL_REQUEST_BYTES, label: 'Clip', invalid: 'This clip isn’t one CloudChef can show.' },
  );
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { body, identity, connection } = authenticated;
  const post = await managedPost(env, body.orgProjectId, identity.userId, connection.id);
  if (!post) {
    return json({ error: NO_POST }, 409);
  }
  const { timeline } = body.reel;
  const files = new Map<string, Uint8Array>();
  try {
    for (const [ref, encoded] of Object.entries(body.reel.files)) {
      files.set(ref, base64ToBytes(encoded));
    }
  } catch {
    return json({ error: 'This clip isn’t one CloudChef can show.' }, 400);
  }
  const problem = reelFilesProblem(timeline, files);
  if (problem) {
    return json({ error: problem }, 400);
  }

  const reelId = crypto.randomUUID();
  const ids = new Map(reelRefs(timeline).map((ref) => [ref, crypto.randomUUID()]));
  const refOf = (ref: string) => `${ids.get(ref)!}.${ref.slice(ref.lastIndexOf('.') + 1)}`;
  const stored = new TextEncoder().encode(JSON.stringify(renameReelRefs(timeline, refOf)));
  const keys: string[] = [];
  const parts: NewMedia[] = [];
  let held = false;
  try {
    let position = 0;
    for (const [ref, bytes] of files) {
      const id = ids.get(ref)!;
      const contentType = reelRefContentType(ref);
      const key = mediaKey(post.id, id, contentType);
      await env.SHOWCASE_MEDIA.put(key, bytes, { httpMetadata: { contentType } });
      keys.push(key);
      const still = contentType === 'audio/mpeg' ? null : stillInfo(bytes);
      const state = still ? await classifyMedia(env, bytes, contentType) : 'ready';
      held ||= state === 'pending';
      parts.push({
        id,
        kind: still ? 'reel_still' : 'reel_audio',
        origin: 'agent',
        r2Key: key,
        contentType,
        bytes: bytes.byteLength,
        width: still?.width ?? null,
        height: still?.height ?? null,
        // The first step's picture is the clip's first, shown before it plays.
        position: ref === timeline.steps[0]!.still ? 0 : ++position,
        commit: null,
        state,
      });
    }
    const timelineKey = mediaKey(post.id, reelId, 'application/json');
    await env.SHOWCASE_MEDIA.put(timelineKey, stored, { httpMetadata: { contentType: 'application/json' } });
    keys.push(timelineKey);
    // A picture held for review holds the whole clip: none of it is shown until an operator looks.
    const state = held ? 'pending' : 'ready';
    await replaceReel(env.DB, {
      postId: post.id,
      userId: identity.userId,
      reel: {
        id: reelId,
        kind: 'reel',
        origin: 'agent',
        r2Key: timelineKey,
        contentType: 'application/json',
        bytes: stored.byteLength,
        width: timeline.steps[0]!.width,
        height: timeline.steps[0]!.height,
        durationMs: Math.round(reelSeconds(timeline) * 1000),
        commit: null,
        state,
      },
      parts: parts.map((part) => ({ ...part, state })),
    });
  } catch (error) {
    await env.SHOWCASE_MEDIA.delete(keys).catch(() => undefined);
    if (error instanceof ShowcaseError) {
      return json({ error: error.message }, error.status);
    }
    throw error;
  }
  await deleteGoneMediaBestEffort(env);
  return json({ path: post.path, shown: !held });
}
