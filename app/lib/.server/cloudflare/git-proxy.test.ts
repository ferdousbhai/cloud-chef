import { describe, expect, it } from 'vitest';
import { fakeArtifacts } from '~/test/fake-artifacts';
import {
  GIT_SETUP_HEADER,
  handleGitProxyRequest,
  MAIN_MOVED_REFUSAL,
  mainPushReport,
  type GitProxyDependencies,
} from './git-proxy';
import { ProjectRepositories } from './project-repository';
import { concatBytes, pktLine, readPktLines, ZERO_OID } from './repository-wire';
import type { RefUpdate } from './git-proxy';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const PACK = new TextEncoder().encode('PACK-bytes');
const FLUSH = new TextEncoder().encode('0000');
const SAVED = 'refs/cloudchef/workspaces/w1';

type Sent = { url: string; headers: Headers; body: Uint8Array | null };

function harness(
  options: {
    refusal?: string | null;
    answer?: (sent: Sent) => Response;
    isAncestor?: (ancestor: string, commit: string) => boolean | null;
  } = {},
) {
  const sent: Sent[] = [];
  const revoked: string[] = [];
  const recorded: RefUpdate[] = [];
  const bases: { branch: string; commit: string }[] = [];
  const fetched: string[] = [];
  const pending: Promise<unknown>[] = [];
  const deps: GitProxyDependencies = {
    repository: async () => ({ repo: 'chat-1', orgProjectId: null, base: { branch: 'main', commit: OLD } }),
    author: async () => ({ name: 'Ada\nLovelace', email: 'ada@example.com' }),
    refusal: async () => options.refusal ?? null,
    workspaceRefs: SAVED,
    access: async (_repo, scope) => ({
      url: 'https://artifacts.example/cloudchef/chat-1.git',
      secret: `secret-${scope}`,
      tokenId: `token-${scope}`,
    }),
    revoke: async (_repo, tokenId) => {
      revoked.push(tokenId);
    },
    isAncestor: async (_repo, ancestor, commit) => (options.isAncestor ? options.isAncestor(ancestor, commit) : true),
    secretFilesPushed: async () => [],
    mainHead: async () => null,
    recordPush: async (update) => {
      recorded.push(update);
    },
    recordMainFetched: async (commit) => {
      fetched.push(commit);
    },
    recordBase: async (base) => {
      bases.push(base);
    },
    fetch: async (url, init) => {
      const body = init?.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : null;
      const request = { url, headers: new Headers(init?.headers), body };
      sent.push(request);
      return options.answer ? options.answer(request) : new Response('answer');
    },
    waitUntil: (promise) => {
      pending.push(promise);
    },
  };
  const settled = async () => {
    await Promise.all(pending);
  };
  return { deps, sent, revoked, recorded, bases, fetched, settled };
}

function push(commands: string[], init: { gzip?: boolean } = {}): Request {
  const [first, ...rest] = commands;
  const body = concatBytes([
    pktLine(`${first}\0report-status side-band-64k agent=git/2.47\n`),
    ...rest.map((command) => pktLine(`${command}\n`)),
    FLUSH,
    PACK,
  ]);
  const headers = new Headers({ 'content-type': 'application/x-git-receive-pack-request' });
  if (init.gzip) {
    headers.set('content-encoding', 'gzip');
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers,
      body: new Blob([body]).stream().pipeThrough(new CompressionStream('gzip')),
      duplex: 'half',
    };
    return new Request('http://git.internal/project.git/git-receive-pack', init);
  }
  return new Request('http://git.internal/project.git/git-receive-pack', { method: 'POST', headers, body });
}

/** A side-band receive-pack answer: progress first, then the report. */
function report(lines: string[]): Response {
  const inner = concatBytes([...lines.map((line) => pktLine(`${line}\n`)), FLUSH]);
  const band = (number: number, payload: Uint8Array) =>
    concatBytes([
      new TextEncoder().encode((payload.length + 5).toString(16).padStart(4, '0')),
      Uint8Array.of(number),
      payload,
    ]);
  return new Response(concatBytes([band(2, new TextEncoder().encode('Resolving deltas\n')), band(1, inner), FLUSH]));
}

/** The refs a request to the repository updates, as its commands name them. */
function commandsOf(sent: Sent | undefined): string[] {
  return [...readPktLines(sent?.body ?? new Uint8Array())].flatMap((line) => {
    const ref = /^[0-9a-f]{40} [0-9a-f]{40} ([^\s\0]+)/.exec(new TextDecoder().decode(line))?.[1];
    return ref ? [ref] : [];
  });
}

/**
 * The repository's answer to each request: every ref it updates `ok`, but those under a `refuse` prefix, in
 * the side-band only when the request asked for it.
 */
function repository(refuse: Record<string, string> = {}) {
  return (sent: Sent) => {
    const lines = [
      'unpack ok',
      ...commandsOf(sent).map((ref) => {
        const refused = Object.entries(refuse).find(([prefix]) => ref.startsWith(prefix));
        return refused ? `ng ${ref} ${refused[1]}` : `ok ${ref}`;
      }),
    ];
    return new TextDecoder().decode(sent.body ?? new Uint8Array()).includes('side-band')
      ? report(lines)
      : new Response(concatBytes([...lines.map((line) => pktLine(`${line}\n`)), FLUSH]));
  };
}

async function text(response: Response): Promise<string> {
  return new TextDecoder().decode(await response.arrayBuffer());
}

describe('the workspace git proxy', () => {
  it('tells the container git setup its base commit and author, one per line', async () => {
    const { deps } = harness();
    const response = await handleGitProxyRequest(new Request('http://git.internal/_cloudchef/workspace'), deps);
    expect(await text(response)).toBe(`main ${OLD}\nAda Lovelace\nada@example.com\n${SAVED}\n`);
    const refused = harness({ refusal: 'You no longer have access to this workspace.' });
    const answer = await handleGitProxyRequest(new Request('http://git.internal/_cloudchef/workspace'), refused.deps);
    expect(answer.status).toBe(403);
  });

  it('records where git in the next container starts, as one who may push says it', async () => {
    const say = (body: string) => new Request('http://git.internal/_cloudchef/base', { method: 'POST', body });
    const { deps, bases } = harness();
    expect((await handleGitProxyRequest(say(`feature/x ${NEW}`), deps)).status).toBe(204);
    expect(bases).toEqual([{ branch: 'feature/x', commit: NEW }]);
    for (const bad of ['main', `../main ${NEW}`, `main ${NEW.slice(1)}`]) {
      expect((await handleGitProxyRequest(say(bad), deps)).status).toBe(400);
    }
    const viewer = harness({ refusal: 'You can view this project but not change it.' });
    expect((await handleGitProxyRequest(say(`main ${NEW}`), viewer.deps)).status).toBe(403);
    expect(viewer.bases).toEqual([]);
  });

  it('answers only git for the project repository', async () => {
    const { deps, sent } = harness();
    expect(
      (
        await handleGitProxyRequest(
          new Request('http://git.internal/other.git/info/refs?service=git-upload-pack'),
          deps,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleGitProxyRequest(
          new Request('http://example.com/project.git/info/refs?service=git-upload-pack'),
          deps,
        )
      ).status,
    ).toBe(404);
    expect(
      (await handleGitProxyRequest(new Request('http://git.internal/project.git/info/refs?service=git-archive'), deps))
        .status,
    ).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it('fetches with a read token of its own, never a credential from the container, and revokes it after', async () => {
    const { deps, sent, revoked, settled } = harness();
    const response = await handleGitProxyRequest(
      new Request('http://git.internal/project.git/info/refs?service=git-upload-pack', {
        headers: { authorization: 'Basic container', cookie: 'a=b', 'git-protocol': 'version=2' },
      }),
      deps,
    );
    expect(await text(response)).toBe('answer');
    await settled();
    expect(sent[0]?.url).toBe('https://artifacts.example/cloudchef/chat-1.git/info/refs?service=git-upload-pack');
    expect(sent[0]?.headers.get('authorization')).toBe(`Basic ${btoa('x:secret-read')}`);
    expect(sent[0]?.headers.get('cookie')).toBeNull();
    expect(sent[0]?.headers.get('git-protocol')).toBe('version=2');
    expect(revoked).toEqual(['token-read']);
  });

  it('says why access is refused in terms git prints', async () => {
    const { deps, sent } = harness({ refusal: 'You can view this project but not change it.' });
    const response = await handleGitProxyRequest(
      new Request('http://git.internal/project.git/info/refs?service=git-receive-pack'),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await text(response)).toContain('ERR You can view this project but not change it.');
    expect(sent).toHaveLength(0);
  });

  it('sends a push on whole and records the refs the report says were updated', async () => {
    const { deps, sent, recorded, revoked, settled } = harness({
      answer: repository({ 'refs/heads/feature': 'non-fast-forward' }),
    });
    const response = await handleGitProxyRequest(
      push([`${OLD} ${NEW} refs/heads/main`, `${OLD} ${NEW} refs/heads/feature`]),
      deps,
    );
    const answer = await text(response);
    await settled();
    expect(sent[0]?.url).toBe('https://artifacts.example/cloudchef/chat-1.git/git-receive-pack');
    expect(sent[0]?.headers.get('authorization')).toBe(`Basic ${btoa('x:secret-write')}`);
    expect(new TextDecoder().decode(sent[0]?.body ?? new Uint8Array())).toContain('PACK-bytes');
    expect(answer).toContain('ok refs/heads/main');
    expect(answer).toContain('ng refs/heads/feature non-fast-forward');
    expect(recorded).toEqual([{ ref: 'refs/heads/main', oldOid: OLD, newOid: NEW }]);
    expect(revoked).toEqual(['token-write']);
  });

  it('sends a shared project’s push on as git sent it, for the runtime in its account to stage and check', async () => {
    const { deps, sent, recorded } = harness({ answer: repository() });
    deps.forwarded = () => true;
    await (await handleGitProxyRequest(push([`${OLD} ${NEW} refs/heads/main`]), deps)).arrayBuffer();
    expect(sent).toHaveLength(1);
    expect(commandsOf(sent[0])).toEqual(['refs/heads/main']);
    expect(recorded).toEqual([{ ref: 'refs/heads/main', oldOid: OLD, newOid: NEW }]);
  });

  it("lands main's new commit on a ref of its own, then moves main to it from the commit git read", async () => {
    const { deps, sent, recorded } = harness({ answer: repository() });
    await (await handleGitProxyRequest(push([`${OLD} ${NEW} refs/heads/main`]), deps)).arrayBuffer();

    const [staged] = commandsOf(sent[0]);
    expect(staged).toMatch(/^refs\/cloudchef\/incoming\/[0-9a-f-]{36}$/);
    expect(new TextDecoder().decode(sent[0]?.body ?? new Uint8Array())).toContain(
      `${ZERO_OID} ${NEW} ${staged}\0report-status side-band-64k agent=git/2.47\n`,
    );
    // Main moves from the commit git read, so a push in between isn't overwritten; then the staged ref goes.
    expect(new TextDecoder().decode(sent[1]?.body ?? new Uint8Array())).toContain(`${OLD} ${NEW} refs/heads/main`);
    expect(new TextDecoder().decode(sent[2]?.body ?? new Uint8Array())).toContain(`${NEW} ${ZERO_OID} ${staged}`);
    expect(recorded).toEqual([{ ref: 'refs/heads/main', oldOid: OLD, newOid: NEW }]);
  });

  it('refuses a push that would rewrite main, leaving main where it was', async () => {
    const { deps, sent, recorded } = harness({ answer: repository(), isAncestor: () => false });
    const response = await handleGitProxyRequest(push([`${OLD} ${NEW} refs/heads/main`]), deps);

    expect(await text(response)).toContain('ng refs/heads/main main can’t be rewritten, only added to');
    expect(sent.flatMap(commandsOf).filter((ref) => ref === 'refs/heads/main')).toEqual([]);
    expect(recorded).toEqual([]);
    // The commit it brought is let go.
    expect(commandsOf(sent[1])).toEqual(commandsOf(sent[0]));
  });

  it('refuses main when its history could not be checked in time, and when main moved in between', async () => {
    const unchecked = harness({ answer: repository(), isAncestor: () => null });
    expect(await text(await handleGitProxyRequest(push([`${OLD} ${NEW} refs/heads/main`]), unchecked.deps))).toContain(
      'ng refs/heads/main CloudChef couldn’t check this push against main',
    );
    expect(unchecked.recorded).toEqual([]);

    const raced = harness({ answer: repository({ 'refs/heads/main': 'stale info' }) });
    expect(await text(await handleGitProxyRequest(push([`${OLD} ${NEW} refs/heads/main`]), raced.deps))).toContain(
      'ng refs/heads/main stale info',
    );
    expect(raced.recorded).toEqual([]);
  });

  it('still lets any other branch be rewritten, and main be created, each from the commit git read', async () => {
    const { deps, sent, recorded } = harness({ answer: repository(), isAncestor: () => false });
    await (
      await handleGitProxyRequest(
        push([`${OLD} ${NEW} refs/heads/feature`, `${ZERO_OID} ${NEW} refs/heads/main`]),
        deps,
      )
    ).arrayBuffer();
    // Both land on refs of their own first, then each branch moves, and its staged ref goes.
    expect(commandsOf(sent[0])).toEqual([
      expect.stringMatching(/^refs\/cloudchef\/incoming\//),
      expect.stringMatching(/^refs\/cloudchef\/incoming\//),
    ]);
    const moved = sent.slice(1).map((request) => new TextDecoder().decode(request.body ?? new Uint8Array()));
    expect(moved.filter((body) => body.includes(`${OLD} ${NEW} refs/heads/feature`))).toHaveLength(1);
    expect(moved.filter((body) => body.includes(`${ZERO_OID} ${NEW} refs/heads/main`))).toHaveLength(1);
    expect(recorded.map((update) => update.ref)).toEqual(['refs/heads/feature', 'refs/heads/main']);
  });

  it('checks every branch a push sets for secret files: against its old commit, main, or nothing', async () => {
    const MAIN = 'c'.repeat(40);
    const checked: { base: string | null; commit: string }[] = [];
    const { deps, recorded } = harness({ answer: repository() });
    deps.mainHead = async () => MAIN;
    deps.secretFilesPushed = async (_repo, base, commit) => {
      checked.push({ base, commit });
      return commit === NEW ? ['.env'] : [];
    };
    const answer = await text(
      await handleGitProxyRequest(
        push([
          `${OLD} ${NEW} refs/heads/feature`,
          `${ZERO_OID} ${NEW} refs/heads/fresh`,
          `${ZERO_OID} ${OLD} refs/heads/clean`,
          `${ZERO_OID} ${NEW} refs/heads/main`,
        ]),
        deps,
      ),
    );
    expect(checked).toEqual([
      { base: OLD, commit: NEW },
      { base: MAIN, commit: NEW },
      { base: MAIN, commit: OLD },
      { base: null, commit: NEW },
    ]);
    for (const ref of ['feature', 'fresh', 'main']) {
      expect(answer).toContain(`ng refs/heads/${ref} .env holds secrets and can't be pushed`);
    }
    expect(answer).toContain('ok refs/heads/clean');
    expect(recorded.map((update) => update.ref)).toEqual(['refs/heads/clean']);

    // A branch that can't be checked isn't moved.
    const unchecked = harness({ answer: repository() });
    unchecked.deps.mainHead = async () => {
      throw new Error('unavailable');
    };
    expect(
      await text(await handleGitProxyRequest(push([`${ZERO_OID} ${NEW} refs/heads/fresh`]), unchecked.deps)),
    ).toContain('ng refs/heads/fresh CloudChef couldn’t check this push');
    expect(unchecked.recorded).toEqual([]);

    // Nor is one bringing more commits than can be checked.
    const long = harness({ answer: repository() });
    long.deps.secretFilesPushed = async () => null;
    expect(await text(await handleGitProxyRequest(push([`${OLD} ${NEW} refs/heads/main`]), long.deps))).toContain(
      'ng refs/heads/main This push brings too many commits for CloudChef to check at once',
    );
    expect(long.recorded).toEqual([]);
  });

  it('records a push before git has read the whole answer, so the command that pushed sees it', async () => {
    const { deps, recorded } = harness({ answer: repository() });
    const slow = deps.recordPush;
    deps.recordPush = async (update) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await slow(update);
    };
    await (await handleGitProxyRequest(push([`${OLD} ${NEW} refs/heads/main`]), deps)).arrayBuffer();
    expect(recorded).toEqual([{ ref: 'refs/heads/main', oldOid: OLD, newOid: NEW }]);
  });

  it('sends a gzip push on decoded, without its encoding', async () => {
    const { deps, sent, recorded, settled } = harness({ answer: repository() });
    const response = await handleGitProxyRequest(push([`${OLD} ${NEW} refs/heads/feature`], { gzip: true }), deps);
    await response.arrayBuffer();
    await settled();
    expect(sent[0]?.headers.get('content-encoding')).toBeNull();
    expect(new TextDecoder().decode(sent[0]?.body ?? new Uint8Array())).toContain(
      `${ZERO_OID} ${NEW} refs/cloudchef/incoming/`,
    );
    expect(new TextDecoder().decode(sent[1]?.body ?? new Uint8Array())).toContain(`${OLD} ${NEW} refs/heads/feature`);
    expect(recorded).toHaveLength(1);
  });

  it('refuses deleting main and pushing anything but branches and tags, before anything is sent', async () => {
    for (const command of [`${OLD} ${ZERO_OID} refs/heads/main`, `${OLD} ${NEW} refs/notes/commits`]) {
      const { deps, sent } = harness();
      const response = await handleGitProxyRequest(push([command]), deps);
      const body = await text(response);
      expect(body).toContain('ng refs/');
      expect(sent).toHaveLength(0);
    }
  });

  it('refuses a push the person may no longer make, in the push report', async () => {
    const { deps, sent, recorded } = harness({ refusal: 'You no longer have access to this workspace.' });
    const response = await handleGitProxyRequest(push([`${OLD} ${NEW} refs/heads/main`]), deps);
    expect(await text(response)).toContain('ng refs/heads/main You no longer have access to this workspace.');
    expect(sent).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it('records nothing when the pack was not unpacked', async () => {
    const { deps, recorded, settled } = harness({
      answer: () => report(['unpack index-pack failed', 'ng refs/heads/main unpacker error']),
    });
    await (await handleGitProxyRequest(push([`${OLD} ${NEW} refs/heads/main`]), deps)).arrayBuffer();
    await settled();
    expect(recorded).toHaveLength(0);
  });

  it("saves the workspace's own branches freely, without recording them as pushed", async () => {
    const { deps, sent, recorded, settled } = harness({
      answer: () => report(['unpack ok', `ok ${SAVED}/main`, `ok ${SAVED}/feature`]),
    });
    const response = await handleGitProxyRequest(
      push([`${OLD} ${NEW} ${SAVED}/main`, `${OLD} ${ZERO_OID} ${SAVED}/feature`]),
      deps,
    );
    await response.arrayBuffer();
    await settled();
    expect(sent).toHaveLength(1);
    expect(recorded).toEqual([]);
  });

  it("refuses writing another workspace's saved branches, or anything else of CloudChef's", async () => {
    for (const ref of ['refs/cloudchef/workspaces/w2/main', 'refs/cloudchef/workspaces/w1', 'refs/cloudchef/other']) {
      const { deps, sent } = harness();
      const response = await handleGitProxyRequest(push([`${OLD} ${NEW} ${ref}`]), deps);
      expect(await text(response)).toContain(`ng ${ref} Only branches and tags can be pushed`);
      expect(sent).toHaveLength(0);
    }
  });

  it("leaves other workspaces' saved branches out of what the repository lists, keeping its capabilities", async () => {
    const refs = (lines: string[]) =>
      new Response(
        concatBytes([pktLine('# service=git-upload-pack\n'), FLUSH, ...lines.map((line) => pktLine(line)), FLUSH]),
      );
    const advertise = new Request('http://git.internal/project.git/info/refs?service=git-upload-pack');
    const listed = harness({
      answer: () =>
        refs([
          `${OLD} refs/cloudchef/workspaces/w2/main\0multi_ack side-band-64k\n`,
          `${NEW} ${SAVED}/main\n`,
          `${OLD} refs/heads/main\n`,
          `${OLD} refs/notes/commits\n`,
          `${NEW} refs/tags/v1^{}\n`,
        ]),
    });
    expect(await text(await handleGitProxyRequest(advertise, listed.deps))).toBe(
      new TextDecoder().decode(
        concatBytes([
          pktLine('# service=git-upload-pack\n'),
          FLUSH,
          pktLine(`${NEW} ${SAVED}/main\0multi_ack side-band-64k\n`),
          pktLine(`${OLD} refs/heads/main\n`),
          pktLine(`${NEW} refs/tags/v1^{}\n`),
          FLUSH,
        ]),
      ),
    );
    await listed.settled();
    expect(listed.revoked).toEqual(['token-read']);
    // What a fetch lists main at is what origin/main is in the workspace now; a push's list changes nothing there.
    expect(listed.fetched).toEqual([OLD]);
    const pushing = harness({ answer: () => refs([`${OLD} refs/heads/main\0report-status\n`]) });
    await (
      await handleGitProxyRequest(
        new Request('http://git.internal/project.git/info/refs?service=git-receive-pack'),
        pushing.deps,
      )
    ).arrayBuffer();
    expect(pushing.fetched).toEqual([]);

    const hidden = harness({ answer: () => refs([`${OLD} refs/cloudchef/workspaces/w2/main\0multi_ack\n`]) });
    expect(await text(await handleGitProxyRequest(advertise, hidden.deps))).toContain(
      `${ZERO_OID} capabilities^{}\0multi_ack\n`,
    );
  });

  it("leaves other workspaces' saved branches out of protocol v2's ref list, and passes a fetch on as it is", async () => {
    const v2 = (command: string) =>
      new Request('http://git.internal/project.git/git-upload-pack', {
        method: 'POST',
        headers: { 'git-protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request' },
        body: concatBytes([
          pktLine(`command=${command}\n`),
          new TextEncoder().encode('0001'),
          pktLine('peel\n'),
          FLUSH,
        ]),
      });
    const lines = [
      `${OLD} HEAD symref-target:refs/heads/main\n`,
      `${NEW} refs/cloudchef/workspaces/w2/x\n`,
      `${OLD} refs/heads/main\n`,
    ];
    const answer = () => new Response(concatBytes([...lines.map((line) => pktLine(line)), FLUSH]));
    const listing = harness({ answer });
    const listed = await text(await handleGitProxyRequest(v2('ls-refs'), listing.deps));
    expect(listed).not.toContain('workspaces/w2');
    expect(listed).toContain(`${OLD} refs/heads/main`);
    expect(listing.fetched).toEqual([OLD]);
    // The container's setup fetch after a restart moves no file: what it lists isn't taken.
    const setup = harness({ answer });
    const request = v2('ls-refs');
    request.headers.set(GIT_SETUP_HEADER, '1');
    expect(await text(await handleGitProxyRequest(request, setup.deps))).toContain(`${OLD} refs/heads/main`);
    expect(setup.fetched).toEqual([]);
    expect(new TextDecoder().decode(listing.sent[0]?.body ?? new Uint8Array())).toContain('command=ls-refs');

    const fetching = harness({ answer });
    expect(await text(await handleGitProxyRequest(v2('fetch'), fetching.deps))).toContain('workspaces/w2');
  });
});

describe('what the control plane is told of a push', () => {
  it('is a team project’s main, from its old commit (none for the first) to its new one, and nothing else', () => {
    const team = '11111111-1111-4111-8111-111111111111';
    expect(mainPushReport(team, { ref: 'refs/heads/main', oldOid: OLD, newOid: NEW })).toEqual({
      orgProjectId: team,
      oldCommit: OLD,
      newCommit: NEW,
    });
    expect(mainPushReport(team, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: NEW })).toEqual({
      orgProjectId: team,
      oldCommit: null,
      newCommit: NEW,
    });
    expect(mainPushReport(team, { ref: 'refs/heads/feature', oldOid: OLD, newOid: NEW })).toBeNull();
    expect(mainPushReport(team, { ref: 'refs/heads/main', oldOid: OLD, newOid: ZERO_OID })).toBeNull();
    expect(mainPushReport(null, { ref: 'refs/heads/main', oldOid: OLD, newOid: NEW })).toBeNull();
  });
});

describe("main's history in the repository itself", () => {
  async function project() {
    const artifacts = fakeArtifacts();
    const repositories = new ProjectRepositories(artifacts, { fetch: artifacts.fetch });
    await artifacts.create('p-site');
    const first = await artifacts.commitDirect('p-site', 'main', { 'index.html': 'one' });
    const second = await artifacts.commitDirect('p-site', 'main', { 'index.html': 'two' });
    // main back at the first commit, with the second one (its child) in the repository, as if just sent.
    await repositories.resetMain('p-site', first);
    const rewritten = await artifacts.commitDirect('p-site', 'elsewhere', { 'index.html': 'other' });
    const recorded: RefUpdate[] = [];
    const deps: GitProxyDependencies = {
      repository: async () => ({ repo: 'p-site', orgProjectId: null, base: { branch: 'main', commit: first } }),
      author: async () => ({ name: 'Ada', email: 'ada@example.com' }),
      refusal: async () => null,
      workspaceRefs: SAVED,
      access: (repo, scope) => repositories.gitAccess(repo, scope),
      revoke: (repo, tokenId) => repositories.revokeToken(repo, tokenId),
      isAncestor: (repo, ancestor, commit) => repositories.isAncestor(repo, ancestor, commit),
      secretFilesPushed: (repo, base, commit) => repositories.secretFilesPushed(repo, base, commit),
      mainHead: (repo) => repositories.head(repo),
      recordPush: async (update) => {
        recorded.push(update);
      },
      recordBase: async () => undefined,
      recordMainFetched: async () => undefined,
      fetch: artifacts.fetch,
      waitUntil: () => undefined,
    };
    return { artifacts, repositories, deps, recorded, first, second, rewritten };
  }

  it('refuses a force push of main and leaves main as it was', async () => {
    const { artifacts, deps, recorded, first, rewritten } = await project();

    const answer = await text(await handleGitProxyRequest(push([`${first} ${rewritten} refs/heads/main`]), deps));

    expect(answer).toContain('ng refs/heads/main main can’t be rewritten');
    expect(await artifacts.head('p-site')).toBe(first);
    expect(recorded).toEqual([]);
    // No ref is left behind for the commit it brought.
    const incoming = artifacts.pushes.filter((pushed) => pushed.ref.startsWith('refs/cloudchef/incoming/'));
    expect(incoming.map((pushed) => pushed.newOid)).toEqual([rewritten, ZERO_OID]);
  });

  it('says plainly that main moved when another push lands between git reading main and this push', async () => {
    const { artifacts, repositories, deps, recorded, first, second } = await project();
    // Both started from `first`; this one's commit is on top of it, and the other push took main to `second`.
    const mine = await artifacts.commitDirect('p-site', 'main', { 'index.html': 'mine' });
    await repositories.resetMain('p-site', second);

    const answer = await text(await handleGitProxyRequest(push([`${first} ${mine} refs/heads/main`]), deps));

    expect(answer).toContain(`ng refs/heads/main ${MAIN_MOVED_REFUSAL}`);
    expect(MAIN_MOVED_REFUSAL).toContain('git pull');
    expect(await artifacts.head('p-site')).toBe(second);
    expect(recorded).toEqual([]);
  });

  it('moves main for a push that adds to it', async () => {
    const { artifacts, deps, recorded, first, second } = await project();

    const answer = await text(await handleGitProxyRequest(push([`${first} ${second} refs/heads/main`]), deps));

    expect(answer).toContain('ok refs/heads/main');
    expect(await artifacts.head('p-site')).toBe(second);
    expect(recorded).toEqual([{ ref: 'refs/heads/main', oldOid: first, newOid: second }]);
  });

  it('keeps a secret file off main, whichever computer pushed it, but lets an example file through', async () => {
    const { artifacts, repositories, deps, recorded, first } = await project();
    const secret = await artifacts.commitDirect('p-site', 'main', { 'index.html': 'two', 'api/.dev.vars': 'KEY=1' });
    await repositories.resetMain('p-site', first);

    const refused = await text(await handleGitProxyRequest(push([`${first} ${secret} refs/heads/main`]), deps));

    expect(refused).toContain('ng refs/heads/main api/.dev.vars holds secrets');
    expect(await artifacts.head('p-site')).toBe(first);
    expect(recorded).toEqual([]);

    const example = await artifacts.commitDirect('p-site', 'main', { 'index.html': 'two', '.env.example': 'KEY=' });
    await repositories.resetMain('p-site', first);
    const allowed = await text(await handleGitProxyRequest(push([`${first} ${example} refs/heads/main`]), deps));
    expect(allowed).toContain('ok refs/heads/main');
  });

  it('keeps a secret file off a new branch, compared with main, and off main’s first push', async () => {
    const { artifacts, deps, recorded, first } = await project();
    const secret = await artifacts.commitDirect('p-site', 'elsewhere', { 'index.html': 'one', '.env.local': 'KEY=1' });

    const branch = await text(await handleGitProxyRequest(push([`${ZERO_OID} ${secret} refs/heads/fresh`]), deps));
    expect(branch).toContain('ng refs/heads/fresh .env.local holds secrets');
    expect(await artifacts.head('p-site', 'fresh')).toBeNull();

    // A new branch holding only what main already holds is let through.
    const same = await text(await handleGitProxyRequest(push([`${ZERO_OID} ${first} refs/heads/copy`]), deps));
    expect(same).toContain('ok refs/heads/copy');
    expect(recorded).toEqual([{ ref: 'refs/heads/copy', oldOid: ZERO_OID, newOid: first }]);

    // main's first push, in a repository with no main yet, is checked against nothing.
    await artifacts.create('p-empty');
    const lone = await artifacts.commitDirect('p-empty', 'elsewhere', { '.dev.vars': 'KEY=1' });
    deps.repository = async () => ({ repo: 'p-empty', orgProjectId: null, base: { branch: 'main', commit: null } });
    const main = await text(await handleGitProxyRequest(push([`${ZERO_OID} ${lone} refs/heads/main`]), deps));
    expect(main).toContain('ng refs/heads/main .dev.vars holds secrets');
    expect(await artifacts.head('p-empty')).toBeNull();
  });

  it('keeps a secret file in an older commit of a push off every branch, though its last commit holds none', async () => {
    const { artifacts, deps, recorded } = await project();
    // Added, then deleted: its contents would stay in the history the push brings.
    await artifacts.commitDirect('p-site', 'buried', { 'index.html': 'one', 'api/.dev.vars': 'KEY=1' });
    const buried = await artifacts.commitDirect('p-site', 'buried', { 'index.html': 'one' });

    const branch = await text(await handleGitProxyRequest(push([`${ZERO_OID} ${buried} refs/heads/fresh`]), deps));
    expect(branch).toContain('ng refs/heads/fresh api/.dev.vars holds secrets');
    expect(await artifacts.head('p-site', 'fresh')).toBeNull();

    // main's first push, with nothing to compare with.
    await artifacts.create('p-empty');
    await artifacts.commitDirect('p-empty', 'elsewhere', { '.env': 'KEY=1' });
    const lone = await artifacts.commitDirect('p-empty', 'elsewhere', { 'index.html': 'one' });
    deps.repository = async () => ({ repo: 'p-empty', orgProjectId: null, base: { branch: 'main', commit: null } });
    const main = await text(await handleGitProxyRequest(push([`${ZERO_OID} ${lone} refs/heads/main`]), deps));
    expect(main).toContain('ng refs/heads/main .env holds secrets');
    expect(await artifacts.head('p-empty')).toBeNull();
    expect(recorded).toEqual([]);
  });

  it('lets a push through that only brings commits without secrets, though main already held one', async () => {
    const { artifacts, repositories, deps, recorded } = await project();
    // A secret file main already holds, unchanged, isn't the push's: the branch moves.
    const held = await artifacts.commitDirect('p-site', 'main', { 'index.html': 'one', '.env': 'KEY=1' });
    const next = await artifacts.commitDirect('p-site', 'main', { 'index.html': 'next', '.env': 'KEY=1' });
    await repositories.resetMain('p-site', held);

    const answer = await text(await handleGitProxyRequest(push([`${held} ${next} refs/heads/main`]), deps));
    expect(answer).toContain('ok refs/heads/main');
    expect(recorded).toEqual([{ ref: 'refs/heads/main', oldOid: held, newOid: next }]);
  });

  it('lets another branch be rewritten', async () => {
    const { artifacts, deps, recorded, rewritten } = await project();
    const feature = await artifacts.commitDirect('p-site', 'feature', { 'index.html': 'feature' });

    const answer = await text(await handleGitProxyRequest(push([`${feature} ${rewritten} refs/heads/feature`]), deps));

    expect(answer).toContain('ok refs/heads/feature');
    expect(await artifacts.head('p-site', 'feature')).toBe(rewritten);
    expect(recorded).toEqual([{ ref: 'refs/heads/feature', oldOid: feature, newOid: rewritten }]);
  });
});
