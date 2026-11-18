import { z } from 'zod';
import { closeThreadsWentLive, waitingFixes } from '~/lib/cloudflare/data/post-threads.server';
import { forwardToProjectAccount } from './command-line';

/** How long a publish's report waits for the project's account to say which waiting changes it holds. */
const ANCESTORS_TIMEOUT_MS = 20_000;
const ancestorsSchema = z.object({ live: z.array(z.string()) });

/**
 * A production publish of `commit` was recorded (`recordProductionPublish`): the project's threads on their way
 * (docs/proposals/comment-threads.md) whose fix commit is in that commit's history went live with it, and are closed
 * as changed. The history is the project's repository, in its own account: a runtime there is asked (the shared read
 * `ancestors`), whoever reported the publish. A fix commit it can't place (a history too long to walk, a runtime that
 * can't be reached or predates the read) stays on its way, for the next publish or an editor to close. Never throws:
 * the publish stands whatever happens here.
 */
export async function closeThreadsThatWentLive(
  request: Request,
  env: Env,
  publish: { projectId: string; connectionId: string; commit: string; reportedBy: string; at: number },
): Promise<void> {
  try {
    const waiting = await waitingFixes(env.DB, publish.projectId);
    if (waiting.length === 0) {
      return;
    }
    const live = new Set(waiting.filter((fix) => fix.fixCommit === publish.commit).map((fix) => fix.fixCommit));
    const others = [...new Set(waiting.map((fix) => fix.fixCommit).filter((fix) => !live.has(fix)))];
    if (others.length > 0) {
      for (const commit of await liveAmong(request, env, publish, others)) {
        live.add(commit);
      }
    }
    const threadIds = waiting.filter((fix) => live.has(fix.fixCommit)).map((fix) => fix.threadId);
    if (threadIds.length > 0) {
      await closeThreadsWentLive(env.DB, { projectId: publish.projectId, threadIds, at: publish.at });
    }
  } catch (error) {
    console.error('[Threads] Unable to close threads a publish answered', error instanceof Error ? error.message : '');
  }
}

/** Which of `candidates` the published commit has in its history, as a runtime in the project's account reads it. */
async function liveAmong(
  request: Request,
  env: Env,
  publish: { projectId: string; connectionId: string; commit: string; reportedBy: string },
  candidates: readonly string[],
): Promise<string[]> {
  const url = new URL('/api/threads/went-live', request.url);
  url.search = new URLSearchParams({ commit: publish.commit, of: candidates.join(',') }).toString();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ANCESTORS_TIMEOUT_MS);
  });
  const asked = forwardToProjectAccount(new Request(url, { method: 'GET' }), env, {
    project: { id: publish.projectId, connectionId: publish.connectionId },
    userId: publish.reportedBy,
    role: 'view',
    op: 'ancestors',
    workspace: 'went-live',
  });
  const answer = await Promise.race([asked, late]).finally(() => clearTimeout(timer));
  if (!answer) {
    asked.then((unread) => unread.body?.cancel()).catch(() => undefined);
    return [];
  }
  if (!answer.ok) {
    await answer.body?.cancel();
    return [];
  }
  const parsed = ancestorsSchema.safeParse(await answer.json().catch(() => null));
  return parsed.success ? parsed.data.live.filter((commit) => candidates.includes(commit)) : [];
}
