import { atom } from 'nanostores';
import { useEffect, useRef } from 'react';
import { useStore } from '@nanostores/react';
import { z } from 'zod';
import { getJson, postJson, RequestError } from '~/lib/json-request';
import { loadGitProjectId } from './projects.client';

/**
 * Who else has the open project open, and what others changed in it since this person was last here, from the
 * control plane's record of visits and pushes: names and times only, never anything anyone wrote or said.
 */

/** How often a browser with a project open says so; the control plane forgets a visitor after three missed reports. */
const PRESENCE_REPORT_MS = 30_000;

const visitorSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  /** Their agent is running a turn now. */
  working: z.boolean(),
});

export type ProjectVisitor = z.infer<typeof visitorSchema>;

const changedSinceSchema = z.object({ count: z.number(), people: z.array(z.string()), latestAt: z.number() });

export type ChangedSince = z.infer<typeof changedSinceSchema>;

const presenceSchema = z.object({
  here: z.array(visitorSchema),
  changedSince: changedSinceSchema.nullable(),
  /** Whether this person runs the project (its owner, or a team admin), and so may share it. */
  canShare: z.boolean().optional(),
});

/** Whether this person's agent is running a turn in the open project, as the chat's connection reports it. */
export const agentWorkingStore = atom(false);

/** The open project, when this person may share it from its menu; null otherwise. */
export const projectShareStore = atom<string | null>(null);

/** Who else has the open project open now; empty outside a project, or when nobody else is here. */
export const projectVisitorsStore = atom<ProjectVisitor[]>([]);

/** What others changed in the open project since this person was last here, until they close the tip. */
export const projectChangesNoticeStore = atom<ChangedSince | null>(null);

function presencePath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/presence`;
}

/**
 * While the project open in this tab (`workspaceId`) is one the control plane keeps (a team project, or any project
 * several people may open), reports every 30 seconds that this person has it open and whether their agent is working,
 * keeps `projectVisitorsStore` up to date, and says once what others changed since the last visit. A project only
 * its own chat knows of (404) is left alone. Closing the tab, or leaving the project, says so at once.
 */
export function useProjectPresence(workspaceId: string): void {
  const working = useStore(agentWorkingStore);
  const reportNow = useRef<(() => void) | null>(null);

  useEffect(() => {
    let stopped = false;
    let projectId: string | null = null;
    let timer: number | undefined;
    const report = async () => {
      window.clearTimeout(timer);
      if (stopped) {
        return;
      }
      try {
        projectId ??= await loadGitProjectId({ chatInitialId: workspaceId });
        const answer = await postJson(presencePath(projectId), { working: agentWorkingStore.get() }, presenceSchema);
        if (stopped) {
          return;
        }
        projectVisitorsStore.set(answer.here);
        projectShareStore.set(answer.canShare ? projectId : null);
        if (answer.changedSince) {
          projectChangesNoticeStore.set(answer.changedSince);
        }
      } catch (error) {
        if (error instanceof RequestError && error.status === 404) {
          // Not a project the control plane keeps: nobody else can open it.
          stopped = true;
          projectId = null;
          projectVisitorsStore.set([]);
          return;
        }
        // A missed report is made again at the next one; three in a row and the others stop seeing this person.
      }
      if (!stopped) {
        timer = window.setTimeout(() => void report(), PRESENCE_REPORT_MS);
      }
    };
    const leave = () => {
      if (projectId !== null) {
        // Sent as the page goes away; `keepalive` lets it outlive the page.
        void fetch(presencePath(projectId), {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ working: false, leaving: true }),
        }).catch(() => undefined);
      }
    };
    // Coming back to a tab the browser had slowed down reports at once, rather than up to a minute later.
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void report();
      }
    };
    reportNow.current = () => void report();
    void report();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', leave);
    return () => {
      stopped = true;
      reportNow.current = null;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', leave);
      leave();
      projectVisitorsStore.set([]);
      projectShareStore.set(null);
      projectChangesNoticeStore.set(null);
    };
  }, [workspaceId]);

  // The agent starting or finishing work is told at once, not at the next report.
  const reportedWorking = useRef(working);
  useEffect(() => {
    if (reportedWorking.current !== working) {
      reportedWorking.current = working;
      reportNow.current?.();
    }
  }, [working]);
}

/** Whether a version of main is live now, was live before a newer one, is on its way, or didn't go live. */
const publishStateSchema = z.enum(['live', 'published', 'publishing', 'failed']);

export type PublishState = z.infer<typeof publishStateSchema>;

const mainChangesSchema = z.object({
  changes: z.array(
    z.object({
      kind: z.enum(['push', 'rewrite']),
      by: z.object({ id: z.string(), name: z.string() }).nullable(),
      oldCommit: z.string().nullable(),
      newCommit: z.string(),
      at: z.number(),
    }),
  ),
  publishes: z.record(z.string(), publishStateSchema).catch({}),
});

/** Who published each version of main, and when, by commit, with what became of each where known. */
export type MainPublishes = {
  /** By the commit a push moved main to: who, when, and main's commit before it (null for main's first). */
  by: Map<string, { name: string | null; at: number; oldCommit: string | null }>;
  states: Map<string, PublishState>;
};

/**
 * Who published the project's recent versions (pushed main), and which is live, for the History dialog: none for a
 * project the control plane doesn't keep.
 */
export async function loadMainPublishes(projectId: string, signal?: AbortSignal): Promise<MainPublishes> {
  try {
    const answer = await getJson(
      `/api/projects/${encodeURIComponent(projectId)}/main-changes?limit=100`,
      mainChangesSchema,
      undefined,
      signal,
    );
    const by: MainPublishes['by'] = new Map();
    for (const change of answer.changes) {
      // Newest first: a commit pushed twice (after a rewrite away and back) goes by its newest.
      if (!by.has(change.newCommit)) {
        by.set(change.newCommit, { name: change.by?.name ?? null, at: change.at, oldCommit: change.oldCommit });
      }
    }
    return { by, states: new Map(Object.entries(answer.publishes)) };
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) {
      return { by: new Map(), states: new Map() };
    }
    throw error;
  }
}

/**
 * For each version that reached main inside a later push rather than as its last commit, how that push went: 'live'
 * when it went live (now or before a newer one), otherwise 'published'. Read down the history, newest first: a push's
 * last commit starts it, and it reaches back until main's commit before that push. A version no recorded push brought
 * (older than the record, or a push made outside CloudChef) isn't in it.
 */
export function carriedVersions(
  hashes: readonly string[],
  publishes: MainPublishes,
): Map<string, 'live' | 'published'> {
  const carried = new Map<string, 'live' | 'published'>();
  let push: { oldCommit: string | null; wentLive: boolean } | null = null;
  for (const hash of hashes) {
    const pushed = publishes.by.get(hash);
    if (pushed) {
      const state = publishes.states.get(hash);
      push = { oldCommit: pushed.oldCommit, wentLive: state === 'live' || state === 'published' };
      continue;
    }
    if (push && hash === push.oldCommit) {
      push = null;
    }
    if (push) {
      carried.set(hash, push.wentLive ? 'live' : 'published');
    }
  }
  return carried;
}
