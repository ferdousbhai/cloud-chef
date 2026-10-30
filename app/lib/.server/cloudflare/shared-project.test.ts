import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerSharedRead,
  readSharedCapabilitySubject,
  sharedCapabilitySubject,
  sharedWorkspaceName,
  sharedWorkspaceRefsId,
  SharedProjectRepositories,
} from './shared-project';
import { ProjectRepositoryError } from './project-repository';

const COMMIT = {
  hash: 'c'.repeat(40),
  treeHash: 't'.repeat(40),
  message: 'Add the menu',
  author: { name: 'Ada', email: 'ada@example.com' },
  committedAt: 1,
  parents: [],
};
const PROJECT = '44444444-4444-4444-8444-444444444444';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The project's own account, answering from a repository holding two files and a built one. */
const repositories = {
  head: async () => COMMIT.hash,
  resolve: async (_repo: string, ref: string) => (ref === 'main' || ref === COMMIT.hash ? COMMIT : null),
  log: async () => [COMMIT],
  streamFilesAt: async (_repo: string, _ref: string, keep: (path: string) => boolean = () => true) => {
    const all = [
      { path: 'src/index.ts', mode: '100644', oid: '1'.repeat(40), bytes: new TextEncoder().encode('export {};\n') },
      { path: 'run.sh', mode: '100755', oid: '2'.repeat(40), bytes: new TextEncoder().encode('#!/bin/sh\n') },
      { path: 'dist/out.js', mode: '100644', oid: '3'.repeat(40), bytes: new TextEncoder().encode('built') },
    ].filter((file) => keep(file.path));
    async function* files() {
      yield* all;
    }
    return { commit: COMMIT, count: all.length, files: files() };
  },
  archiveZip: async () => ({ commit: COMMIT, stream: new Response('zip').body! }),
};

describe('a project shared from another account', () => {
  it('names the person, project and role in a subject only the control plane signs', () => {
    const subject = sharedCapabilitySubject({ projectId: PROJECT, role: 'view', userId: 'bo' });
    expect(readSharedCapabilitySubject(subject)).toEqual({ projectId: PROJECT, role: 'view', userId: 'bo' });
    // A person's own capability is not one.
    expect(readSharedCapabilitySubject('bo')).toBeNull();
    expect(readSharedCapabilitySubject(`shared/${PROJECT}/admin/bo`)).toBeNull();
  });

  it('keeps each person’s saved branches in a folder of their own, whatever workspace name is sent', () => {
    expect(sharedWorkspaceRefsId('bo', 'ws1')).toBe('shared-bo-ws1');
    expect(sharedWorkspaceName('../ada')).toBeNull();
    expect(sharedWorkspaceName('refs/cloudchef/workspaces/ada')).toBeNull();
  });

  it('reads a commit’s files across, as the workspace takes them, through CloudChef', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push(`${url.pathname}${url.search} ${new Headers(init?.headers).get('authorization')}`);
        const op = url.pathname.split('/').at(-1)!;
        return answerSharedRead(
          repositories,
          't-recipes',
          op === 'files' ? 'files' : op === 'head' ? 'head' : 'log',
          url.searchParams,
          (path) => !path.startsWith('dist/'),
        );
      }),
    );
    const shared = new SharedProjectRepositories(
      { CLOUDCHEF_CONTROL_PLANE_ENDPOINT: 'https://cloudchef.build', CONTROL_PLANE_SECRET: 's'.repeat(40) },
      { userId: 'bo', connectionId: 'bo-own', connectionGeneration: 1 },
      PROJECT,
    );
    expect(await shared.head('t-recipes')).toBe(COMMIT.hash);
    const { commit, files } = await shared.readFilesAt('t-recipes', 'main');
    expect(commit.hash).toBe(COMMIT.hash);
    expect(files.map((file) => [file.path, file.mode, new TextDecoder().decode(file.bytes)])).toEqual([
      ['src/index.ts', '100644', 'export {};\n'],
      ['run.sh', '100755', '#!/bin/sh\n'],
    ]);
    expect(calls[0]).toBe(`/api/cloudflare/runtime-shared/${PROJECT}/head Bearer ${'s'.repeat(40)}`);
    expect(calls[1]).toBe(`/api/cloudflare/runtime-shared/${PROJECT}/files?ref=main Bearer ${'s'.repeat(40)}`);
  });

  it('says what CloudChef refused in the person’s words', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'This project is not shared with you.' }, { status: 403 })),
    );
    const shared = new SharedProjectRepositories(
      { CLOUDCHEF_CONTROL_PLANE_ENDPOINT: 'https://cloudchef.build', CONTROL_PLANE_SECRET: 's'.repeat(40) },
      { userId: 'bo', connectionId: 'bo-own', connectionGeneration: 1 },
      PROJECT,
    );
    await expect(shared.log('t-recipes', { limit: 5 })).rejects.toEqual(
      new ProjectRepositoryError('This project is not shared with you.', 'refused'),
    );
  });

  it('refuses a ref that is neither main nor a commit', async () => {
    const answer = await answerSharedRead(
      repositories,
      't-recipes',
      'files',
      new URLSearchParams({ ref: 'refs/cloudchef/workspaces/ada/x' }),
      () => true,
    );
    expect(answer.status).toBe(400);
  });
});
