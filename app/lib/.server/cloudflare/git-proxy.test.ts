import { describe, expect, it } from 'vitest';
import { handleGitProxyRequest, type GitProxyDependencies } from './git-proxy';
import { concatBytes, pktLine, ZERO_OID } from './repository-wire';
import type { RefUpdate } from './git-proxy';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const PACK = new TextEncoder().encode('PACK-bytes');
const FLUSH = new TextEncoder().encode('0000');

type Sent = { url: string; headers: Headers; body: Uint8Array | null };

function harness(options: { refusal?: string | null; answer?: (sent: Sent) => Response } = {}) {
  const sent: Sent[] = [];
  const revoked: string[] = [];
  const recorded: RefUpdate[] = [];
  const pending: Promise<unknown>[] = [];
  const deps: GitProxyDependencies = {
    repository: async () => ({ repo: 'chat-1', orgProjectId: null, base: { branch: 'main', commit: OLD } }),
    author: async () => ({ name: 'Ada\nLovelace', email: 'ada@example.com' }),
    refusal: async () => options.refusal ?? null,
    access: async (_repo, scope) => ({
      url: 'https://artifacts.example/cloudchef/chat-1.git',
      secret: `secret-${scope}`,
      tokenId: `token-${scope}`,
    }),
    revoke: async (_repo, tokenId) => {
      revoked.push(tokenId);
    },
    recordPush: async (update) => {
      recorded.push(update);
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
  return { deps, sent, revoked, recorded, settled };
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

async function text(response: Response): Promise<string> {
  return new TextDecoder().decode(await response.arrayBuffer());
}

describe('the workspace git proxy', () => {
  it('tells the container git setup its base commit and author, one per line', async () => {
    const { deps } = harness();
    const response = await handleGitProxyRequest(new Request('http://git.internal/_cloudchef/workspace'), deps);
    expect(await text(response)).toBe(`main ${OLD}\nAda Lovelace\nada@example.com\n`);
    const refused = harness({ refusal: 'You no longer have access to this workspace.' });
    const answer = await handleGitProxyRequest(new Request('http://git.internal/_cloudchef/workspace'), refused.deps);
    expect(answer.status).toBe(403);
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
      answer: () => report(['unpack ok', 'ok refs/heads/main', 'ng refs/heads/feature non-fast-forward']),
    });
    const response = await handleGitProxyRequest(
      push([`${OLD} ${NEW} refs/heads/main`, `${OLD} ${NEW} refs/heads/feature`]),
      deps,
    );
    await response.arrayBuffer();
    await settled();
    expect(sent[0]?.url).toBe('https://artifacts.example/cloudchef/chat-1.git/git-receive-pack');
    expect(sent[0]?.headers.get('authorization')).toBe(`Basic ${btoa('x:secret-write')}`);
    expect(new TextDecoder().decode(sent[0]?.body ?? new Uint8Array())).toContain('PACK-bytes');
    expect(recorded).toEqual([{ ref: 'refs/heads/main', oldOid: OLD, newOid: NEW }]);
    expect(revoked).toEqual(['token-write']);
  });

  it('records a push before git has read the whole answer, so the command that pushed sees it', async () => {
    const { deps, recorded } = harness({ answer: () => report(['unpack ok', 'ok refs/heads/main']) });
    const slow = deps.recordPush;
    deps.recordPush = async (update) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await slow(update);
    };
    await (await handleGitProxyRequest(push([`${OLD} ${NEW} refs/heads/main`]), deps)).arrayBuffer();
    expect(recorded).toEqual([{ ref: 'refs/heads/main', oldOid: OLD, newOid: NEW }]);
  });

  it('sends a gzip push on decoded, without its encoding', async () => {
    const { deps, sent, recorded, settled } = harness({ answer: () => report(['unpack ok', 'ok refs/heads/main']) });
    const response = await handleGitProxyRequest(push([`${OLD} ${NEW} refs/heads/main`], { gzip: true }), deps);
    await response.arrayBuffer();
    await settled();
    expect(sent[0]?.headers.get('content-encoding')).toBeNull();
    expect(new TextDecoder().decode(sent[0]?.body ?? new Uint8Array())).toContain(`${OLD} ${NEW} refs/heads/main`);
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
});
