import type { BuilderWorkspaceGitRepository } from '~/agents/builder-workspace-api';
import { concatBytes, pktLine, readPktLines, ZERO_OID, type GitFetch, type GitRemote } from './repository-wire';

/**
 * git in the workspace container reaches the project's repository only through this address. The
 * container's requests to it are intercepted and answered by the runtime's GitProxy, which adds a
 * short-lived token and checks the person's access, so nothing in the container ever holds a credential.
 */
export const GIT_PROXY_HOST = 'git.internal';

const REPOSITORY_PATH = '/project.git';
/** Asked by the container's git setup, never by git itself. */
const WORKSPACE_PATH = '/_cloudchef/workspace';
const MAIN_REF = 'refs/heads/main';
/** A push's command section is a few lines per ref; anything larger is not a push git sends. */
const MAX_COMMAND_BYTES = 64 * 1024;
/** The push's answer is its report and progress lines; past this only the report's absence is known. */
const MAX_REPORT_BYTES = 256 * 1024;

type GitService = 'git-upload-pack' | 'git-receive-pack';

/** One of the three requests git's smart HTTP makes: the advertisement, or the service's exchange. */
type GitProxyRoute = { service: GitService; advertisement: boolean };

export type RefUpdate = { ref: string; oldOid: string; newOid: string };

/** The workspace's repository, and the branch and commit its files match (none yet for a new CloudChef app). */
export type GitWorkspaceRepository = BuilderWorkspaceGitRepository & {
  base: { branch: string; commit: string | null };
};

/** What a push's report says of each ref: updated, or refused with the server's reason. */
type PushReport = Map<string, { ok: true } | { ok: false; reason: string }>;

/** The request as one git sends to the project's remote, or null for anything else. */
function gitProxyRoute(request: Request): GitProxyRoute | null {
  const url = new URL(request.url);
  if (url.hostname !== GIT_PROXY_HOST) {
    return null;
  }
  if (request.method === 'GET' && url.pathname === `${REPOSITORY_PATH}/info/refs`) {
    const service = url.searchParams.get('service');
    return service === 'git-upload-pack' || service === 'git-receive-pack' ? { service, advertisement: true } : null;
  }
  if (request.method === 'POST') {
    for (const service of ['git-upload-pack', 'git-receive-pack'] as const) {
      if (url.pathname === `${REPOSITORY_PATH}/${service}`) {
        return { service, advertisement: false };
      }
    }
  }
  return null;
}

/**
 * Reads a receive-pack request's commands, up to the flush that ends them, without reading the pack
 * after it. `body` is the whole request again, the bytes read and then the rest as it arrives.
 */
async function readReceivePackCommands(
  body: ReadableStream<Uint8Array>,
): Promise<{ updates: RefUpdate[]; capabilities: Set<string>; body: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let buffered = new Uint8Array();
  for (;;) {
    const parsed = parseCommands(buffered);
    if (parsed) {
      return { ...parsed, body: prefixed(buffered, reader) };
    }
    if (buffered.length > MAX_COMMAND_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new GitProxyRefusal('The push is not one CloudChef can read.');
    }
    const { done, value } = await reader.read();
    if (done) {
      throw new GitProxyRefusal('The push ended before its commands did.');
    }
    chunks.push(value);
    buffered = concatBytes(chunks);
  }
}

/** The commands in `bytes` when their flush has arrived, or null while it hasn't. */
function parseCommands(bytes: Uint8Array): { updates: RefUpdate[]; capabilities: Set<string> } | null {
  const updates: RefUpdate[] = [];
  const capabilities = new Set<string>();
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(offset, offset + 4)), 16);
    if (!Number.isFinite(length) || (length > 0 && length < 4)) {
      throw new GitProxyRefusal('The push is not one CloudChef can read.');
    }
    if (length === 0) {
      return { updates, capabilities };
    }
    if (offset + length > bytes.length) {
      return null;
    }
    const text = new TextDecoder().decode(bytes.subarray(offset + 4, offset + length)).replace(/\n$/, '');
    offset += length;
    if (text.startsWith('shallow ')) {
      continue;
    }
    if (text.startsWith('push-cert')) {
      throw new GitProxyRefusal('Signed pushes are not supported.');
    }
    const [command, offered] = text.split('\0');
    for (const capability of offered?.split(' ') ?? []) {
      if (capability) {
        capabilities.add(capability);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(command ?? '');
    if (!match) {
      throw new GitProxyRefusal('The push is not one CloudChef can read.');
    }
    updates.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  return null;
}

/**
 * Why a push's ref updates are refused, or null. Only branches and tags may be pushed, and `main`, which
 * is what people see, may not be deleted.
 */
function refusedRefUpdate(updates: readonly RefUpdate[]): string | null {
  for (const update of updates) {
    if (!/^refs\/(heads|tags)\/\S+$/.test(update.ref)) {
      return `Only branches and tags can be pushed, not ${update.ref}.`;
    }
    if (update.ref === MAIN_REF && update.newOid === ZERO_OID) {
      return 'main can’t be deleted.';
    }
  }
  return null;
}

/** A refusal said to git in its own terms, so the person's agent reads the reason, not an HTTP status. */
class GitProxyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitProxyRefusal';
  }
}

/** An advertisement answer that only says why: git prints it as `fatal: remote error: <reason>`. */
function gitRefusalAdvertisement(service: GitService, reason: string): Response {
  const body = concatBytes([
    pktLine(`# service=${service}\n`),
    new TextEncoder().encode('0000'),
    pktLine(`ERR ${reason}\n`),
  ]);
  return new Response(body, { headers: { 'content-type': `application/x-${service}-advertisement` } });
}

/** A receive-pack answer refusing every ref with `reason`, in the side-band the push asked for. */
function gitRefusalReport(updates: readonly RefUpdate[], capabilities: Set<string>, reason: string): Response {
  const report = concatBytes([
    pktLine('unpack ok\n'),
    ...updates.map((update) => pktLine(`ng ${update.ref} ${reason}\n`)),
    new TextEncoder().encode('0000'),
  ]);
  const sideBand = capabilities.has('side-band-64k') || capabilities.has('side-band');
  const body = sideBand
    ? concatBytes([
        bandLine(1, report),
        bandLine(2, new TextEncoder().encode(`${reason}\n`)),
        new TextEncoder().encode('0000'),
      ])
    : report;
  return new Response(body, { headers: { 'content-type': 'application/x-git-receive-pack-result' } });
}

function bandLine(band: number, payload: Uint8Array): Uint8Array {
  const length = (payload.length + 5).toString(16).padStart(4, '0');
  return concatBytes([new TextEncoder().encode(length), Uint8Array.of(band), payload]);
}

/** The report-status in a receive-pack answer, its side-band unwrapped; progress lines are skipped. */
function readPushReport(body: Uint8Array) {
  let lines = [...readPktLines(body)];
  if (lines.some((line) => line[0] !== undefined && line[0] <= 3)) {
    lines = [...readPktLines(concatBytes(lines.filter((line) => line[0] === 1).map((line) => line.subarray(1))))];
  }
  const refs: PushReport = new Map();
  let unpack: string | null = null;
  for (const line of lines) {
    const text = new TextDecoder().decode(line).replace(/\n$/, '');
    if (text.startsWith('unpack ')) {
      unpack = text.slice('unpack '.length);
    } else if (text.startsWith('ok ')) {
      refs.set(text.slice(3), { ok: true });
    } else if (text.startsWith('ng ')) {
      const [ref = '', ...reason] = text.slice(3).split(' ');
      refs.set(ref, { ok: false, reason: reason.join(' ') });
    }
  }
  return { unpack, refs };
}

/**
 * Sends git's request on to the repository's real remote with `remote`'s token, and returns its answer.
 * Only the headers git's protocol needs go on: nothing the container sends can stand in for the token.
 */
function forwardGitRequest(
  fetchGit: GitFetch,
  remote: GitRemote,
  request: Request,
  route: GitProxyRoute,
  body: { stream: ReadableStream<Uint8Array>; decoded: boolean } | null,
): Promise<Response> {
  const headers = new Headers({ authorization: `Basic ${btoa(`x:${remote.secret}`)}` });
  // A body already decoded is sent as it now is, without the encoding it arrived in.
  const passed = body?.decoded
    ? ['accept', 'content-type', 'git-protocol']
    : ['accept', 'content-type', 'content-encoding', 'git-protocol'];
  for (const name of passed) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  const url = route.advertisement
    ? `${remote.url}/info/refs?service=${route.service}`
    : `${remote.url}/${route.service}`;
  const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers, redirect: 'manual' };
  if (body) {
    init.body = body.stream;
    init.duplex = 'half';
  }
  return fetchGit(url, init);
}

/**
 * Passes `response` on while keeping up to MAX_REPORT_BYTES of it, and holds its last chunk back until
 * `report` has had all of it: git finishes only once that chunk arrives, so what `report` records is there
 * before the command that pushed returns.
 */
function observedResponse(response: Response, report: (bytes: Uint8Array) => Promise<void>): Response {
  if (!response.body) {
    return response;
  }
  const kept: Uint8Array[] = [];
  let total = 0;
  let held: Uint8Array | null = null;
  const observer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (total < MAX_REPORT_BYTES) {
        kept.push(chunk.subarray(0, MAX_REPORT_BYTES - total));
        total += chunk.length;
      }
      if (held) {
        controller.enqueue(held);
      }
      held = chunk;
    },
    async flush(controller) {
      await report(concatBytes(kept));
      if (held) {
        controller.enqueue(held);
      }
    },
  });
  return new Response(response.body.pipeThrough(observer), response);
}

/** A receive-pack request's body as git's commands can be read from it: gzip, which git may use, undone. */
function decodedRequestBody(request: Request): ReadableStream<Uint8Array> | null {
  if (!request.body) {
    return null;
  }
  return request.headers.get('content-encoding') === 'gzip'
    ? request.body.pipeThrough(new DecompressionStream('gzip'))
    : request.body;
}

/** What the proxy needs of the workspace it serves, the person's access, and the account's repositories. */
export type GitProxyDependencies = {
  repository(): Promise<GitWorkspaceRepository | null>;
  /** Who commits made in the workspace are by: the person, as the project's history names them. */
  author(): Promise<{ name: string; email: string }>;
  /** Why this person may not fetch (`write` false) or push to the repository now, or null when they may. */
  refusal(target: BuilderWorkspaceGitRepository, write: boolean): Promise<string | null>;
  access(repo: string, scope: 'read' | 'write'): Promise<GitRemote & { tokenId: string }>;
  revoke(repo: string, tokenId: string): Promise<void>;
  recordPush(update: RefUpdate): Promise<void>;
  fetch: GitFetch;
  waitUntil(promise: Promise<unknown>): void;
};

/**
 * Answers git in the workspace container for the project's repository: it checks the person may use it,
 * sends the request on with a token made for it (revoked once the answer has been sent), and records the
 * refs a push updated.
 */
export async function handleGitProxyRequest(request: Request, deps: GitProxyDependencies): Promise<Response> {
  if (isWorkspaceRequest(request)) {
    return workspaceAnswer(deps);
  }
  const route = gitProxyRoute(request);
  if (!route) {
    return new Response('Not found.', { status: 404 });
  }
  const write = route.service === 'git-receive-pack';
  const target = await deps.repository();
  const refusal = await gitRefusal(deps, target, write);
  if (route.advertisement && refusal) {
    return gitRefusalAdvertisement(route.service, refusal);
  }

  let body: { stream: ReadableStream<Uint8Array>; decoded: boolean } | null = null;
  let updates: RefUpdate[] = [];
  if (write && !route.advertisement) {
    const decoded = decodedRequestBody(request);
    if (!decoded) {
      return new Response('A push needs a body.', { status: 400 });
    }
    try {
      const commands = await readReceivePackCommands(decoded);
      updates = commands.updates;
      const refused = refusal ?? refusedRefUpdate(updates);
      if (refused) {
        await commands.body.cancel().catch(() => undefined);
        return gitRefusalReport(updates, commands.capabilities, refused);
      }
      body = { stream: commands.body, decoded: true };
    } catch (error) {
      if (error instanceof GitProxyRefusal) {
        return new Response(error.message, { status: 400 });
      }
      throw error;
    }
  } else if (refusal) {
    return new Response(refusal, { status: 403 });
  } else if (request.body) {
    body = { stream: request.body, decoded: false };
  }

  // Past the refusals above, `target` is known.
  const repo = target!.repo;
  const remote = await deps.access(repo, write ? 'write' : 'read');
  const revoke = () => deps.revoke(repo, remote.tokenId).catch(() => undefined);
  let response: Response;
  try {
    response = await forwardGitRequest(deps.fetch, remote, request, route, body);
  } catch (error) {
    deps.waitUntil(revoke());
    throw error;
  }
  if (!response.body) {
    deps.waitUntil(revoke());
    return response;
  }
  return observedResponse(response, async (answer) => {
    deps.waitUntil(revoke());
    if (updates.length === 0 || !response.ok) {
      return;
    }
    try {
      const report = readPushReport(answer);
      for (const update of updates) {
        if (report.unpack === 'ok' && report.refs.get(update.ref)?.ok) {
          await deps.recordPush(update);
        }
      }
    } catch (error) {
      console.error('Unable to record a git push', error);
    }
  });
}

async function gitRefusal(
  deps: GitProxyDependencies,
  target: GitWorkspaceRepository | null,
  write: boolean,
): Promise<string | null> {
  if (!target) {
    return 'This workspace has no project repository yet. Send a message in the chat first.';
  }
  return deps.refusal(target, write).catch(() => 'CloudChef could not confirm your access just now. Try again.');
}

function isWorkspaceRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.hostname === GIT_PROXY_HOST && request.method === 'GET' && url.pathname === WORKSPACE_PATH;
}

/**
 * What git in a new container sets itself up from, as lines its shell setup reads: the branch and commit
 * the workspace's files match (`-` for none yet), then the author's name and email.
 */
async function workspaceAnswer(deps: GitProxyDependencies): Promise<Response> {
  const target = await deps.repository();
  const refusal = await gitRefusal(deps, target, false);
  if (refusal || !target) {
    return new Response(`${refusal}\n`, { status: 403 });
  }
  const author = await deps.author();
  const line = (value: string) => value.replace(/[\r\n]/g, ' ');
  const body = [
    `${line(target.base.branch)} ${target.base.commit ?? '-'}`,
    line(author.name),
    line(author.email),
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** `head`, then what `reader` gives, read only as fast as it is sent on. */
function prefixed(head: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  let sentHead = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentHead) {
        sentHead = true;
        controller.enqueue(head);
        return;
      }
      const next = await reader.read();
      if (next.done) {
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
