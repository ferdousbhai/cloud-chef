import { describe, expect, it } from 'vitest';
import { cancelSupersededMainBuilds } from './workers-builds';
import type { WorkersBuild, WorkersBuildRepository, WorkersBuildTrigger } from './user-account-api';

const TAG = 'f'.repeat(32);
const WORKER = { tag: TAG, name: 'blog' };
const PROJECT = { repo: 't-blog', importSource: null };
const OLDEST = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);
const NEW = 'c'.repeat(40);
const NEWER = 'd'.repeat(40);

const ARTIFACTS: WorkersBuildRepository = {
  provider: 'artifacts',
  repoId: 'r',
  repoName: 't-blog',
  accountId: null,
  accountName: 'cloudchef',
};
const GITHUB: WorkersBuildRepository = {
  provider: 'github',
  repoId: '1',
  repoName: 'blog',
  accountId: '1',
  accountName: 'ada',
};

function trigger(overrides: Partial<WorkersBuildTrigger> = {}): WorkersBuildTrigger {
  return {
    id: 'trigger',
    name: 'production',
    buildCommand: null,
    deployCommand: null,
    rootDirectory: '/',
    branchIncludes: ['main'],
    branchExcludes: [],
    pathIncludes: ['*'],
    pathExcludes: [],
    repository: ARTIFACTS,
    ...overrides,
  };
}

function build(id: string, commit: string, overrides: Partial<WorkersBuild> = {}): WorkersBuild {
  return {
    id,
    status: 'running',
    outcome: null,
    branch: 'main',
    commit,
    createdOn: null,
    repository: ARTIFACTS,
    ...overrides,
  };
}

/** Workers Builds with these triggers and builds, keeping what it was asked to cancel. */
function account(triggers: WorkersBuildTrigger[], builds: WorkersBuild[], refuse: string[] = []) {
  const cancelled: string[] = [];
  return {
    cancelled,
    api: {
      listWorkersBuildTriggers: async () => triggers,
      listWorkersBuilds: async () => builds,
      cancelWorkersBuild: async (id: string) => {
        if (refuse.includes(id)) {
          throw new Error('This build has already finished.');
        }
        cancelled.push(id);
      },
    },
  };
}

/** The project's history: NEW holds OLDEST and OLDER, and NEWER came after it. */
const asked: string[][] = [];
async function inHistory(commits: string[]): Promise<string[]> {
  asked.push(commits);
  return commits.filter((commit) => commit === OLDEST || commit === OLDER);
}

describe('cancelling the builds a newer push of main supersedes', () => {
  it("cancels main's waiting and running builds of older commits, and leaves every other build", async () => {
    const { api, cancelled } = account(
      [trigger()],
      [
        build('queued-older', OLDER, { status: 'queued' }),
        build('running-oldest', OLDEST, { status: 'running' }),
        build('done-oldest', OLDEST, { status: 'stopped', outcome: 'success' }),
        build('this-push', NEW, { status: 'queued' }),
        build('a-preview', OLDER, { branch: 'feature' }),
        build('from-github', OLDER, { repository: GITHUB }),
      ],
    );
    asked.length = 0;
    const result = await cancelSupersededMainBuilds(api, PROJECT, WORKER, NEW, inHistory);
    expect(result).toEqual(['queued-older', 'running-oldest']);
    expect(cancelled).toEqual(['queued-older', 'running-oldest']);
    expect(asked).toEqual([[OLDER, OLDEST]]);
  });

  it("never cancels a newer push's build when an older push is reported late", async () => {
    const { api, cancelled } = account([trigger()], [build('newer-push', NEWER)]);
    expect(await cancelSupersededMainBuilds(api, PROJECT, WORKER, NEW, inHistory)).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  it('cancels nothing when the history cannot be asked', async () => {
    const { api, cancelled } = account([trigger()], [build('running-older', OLDER)]);
    expect(await cancelSupersededMainBuilds(api, PROJECT, WORKER, NEW, async () => [])).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  it('cancels nothing when watch paths could leave the newer push unbuilt, or the Worker builds from GitHub', async () => {
    const builds = [build('running-older', OLDER)];
    for (const triggers of [
      [trigger({ pathIncludes: ['src/*'] })],
      [trigger({ pathExcludes: ['docs/*'] })],
      [trigger({ repository: GITHUB })],
      [],
    ]) {
      const { api, cancelled } = account(triggers, builds);
      expect(await cancelSupersededMainBuilds(api, PROJECT, WORKER, NEW, inHistory)).toEqual([]);
      expect(cancelled).toEqual([]);
    }
  });

  it('goes on cancelling the rest when one build has already finished', async () => {
    const { api, cancelled } = account(
      [trigger({ pathIncludes: [] })],
      [build('finished-meanwhile', OLDEST), build('running-older', OLDER)],
      ['finished-meanwhile'],
    );
    expect(await cancelSupersededMainBuilds(api, PROJECT, WORKER, NEW, inHistory)).toEqual(['running-older']);
    expect(cancelled).toEqual(['running-older']);
  });
});
