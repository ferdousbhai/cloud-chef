import type { BuilderWorkspaceGitRepository } from '~/agents/builder-workspace-api';
import {
  boundedBytes,
  concatBytes,
  pktLine,
  readPktLines,
  updateRemoteRef,
  ZERO_OID,
  type GitFetch,
  type GitRemote,
} from './repository-wire';

/**
 * git in the workspace container reaches the project's repository only through this address. The
 * container's requests to it are intercepted and answered by the runtime's GitProxy, which adds a
 * short-lived token and checks the person's access, so nothing in the container ever holds a credential.
 */
export const GIT_PROXY_HOST = 'git.internal';

const REPOSITORY_PATH = '/project.git';
/** Asked by the container's git setup, never by git itself. */
const WORKSPACE_PATH = '/_cloudchef/workspace';
/** Where the container's git wrapper says which branch and commit it has checked out, after a push. */
export const GIT_BASE_PATH = '/_cloudchef/base';
const MAIN_REF = 'refs/heads/main';
/**
 * Where a push's new commit for each branch lands first, one ref per branch a push sets: the branch moves to it
 * only once it is checked (see `stagedPush`), and the ref is deleted either way. No push may name these.
 */
const INCOMING_REFS_ROOT = 'refs/cloudchef/incoming';
/** Said, in git's push report, of a push that would rewrite main rather than add to it. */
const MAIN_REWRITE_REFUSAL = 'main can’t be rewritten, only added to: pull, then push again.';
/** Said of a push bringing more commits than can be checked for secret files in one go. */
const PUSH_TOO_LONG_REFUSAL =
  'This push brings too many commits for CloudChef to check at once: push an older commit of it first, then the rest.';
/** Every workspace's saved branches sit under here, each workspace's in its own folder. */
const WORKSPACE_REFS_ROOT = 'refs/cloudchef/workspaces';
/** A push's command section is a few lines per ref; anything larger is not a push git sends. */
const MAX_COMMAND_BYTES = 64 * 1024;
/** The push's answer is its report and progress lines; past this only the report's absence is known. */
const MAX_REPORT_BYTES = 256 * 1024;
/** A ref list is read whole to leave out other workspaces' refs; one larger than this isn't a project's. */
const MAX_REF_LIST_BYTES = 8 * 1024 * 1024;

/**
 * Where a workspace's container keeps its branches in the project's repository, `<prefix>/<branch>`, so its
 * commits outlive the container before they are pushed. Only that workspace may write or see them.
 */
export function workspaceRefsPrefix(workspaceId: string): string {
  return `${WORKSPACE_REFS_ROOT}/${workspaceId}`;
}

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
 * A receive-pack request's commands, and the request itself: `head`, the bytes read so far (the commands,
 * which end at `end`, and maybe the start of the pack), then the rest from `reader` as it arrives.
 */
type ReceivePackCommands = {
  updates: RefUpdate[];
  capabilities: Set<string>;
  head: Uint8Array;
  end: number;
  reader: ReadableStreamDefaultReader<Uint8Array>;
};

/** Reads a receive-pack request's commands, up to the flush that ends them, without reading the pack after it. */
async function readReceivePackCommands(body: ReadableStream<Uint8Array>): Promise<ReceivePackCommands> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let buffered = new Uint8Array();
  for (;;) {
    const parsed = parseCommands(buffered);
    if (parsed) {
      return { ...parsed, head: buffered, reader };
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
function parseCommands(bytes: Uint8Array): { updates: RefUpdate[]; capabilities: Set<string>; end: number } | null {
  const updates: RefUpdate[] = [];
  const capabilities = new Set<string>();
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(offset, offset + 4)), 16);
    if (!Number.isFinite(length) || (length > 0 && length < 4)) {
      throw new GitProxyRefusal('The push is not one CloudChef can read.');
    }
    if (length === 0) {
      return { updates, capabilities, end: offset + 4 };
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

/** A branch a push sets, and the ref its new commit lands on first instead. */
type StagedUpdate = { update: RefUpdate; staged: RefUpdate };

/**
 * The push's request with each staged branch's command made its staged ref's instead: each other command, and
 * the capabilities the first one carries, as git sent them, and the pack after them untouched.
 */
function rewrittenPush(commands: ReceivePackCommands, staged: readonly StagedUpdate[]): ReadableStream<Uint8Array> {
  const lines: Uint8Array[] = [];
  for (const line of readPktLines(commands.head.subarray(0, commands.end))) {
    const text = new TextDecoder().decode(line);
    const [command = '', offered] = text.replace(/\n$/, '').split('\0');
    const to = staged.find(({ update }) => command === `${update.oldOid} ${update.newOid} ${update.ref}`)?.staged;
    lines.push(
      to
        ? pktLine(`${to.oldOid} ${to.newOid} ${to.ref}${offered === undefined ? '' : `\0${offered}`}\n`)
        : pktLine(text),
    );
  }
  const head = concatBytes([...lines, new TextEncoder().encode('0000'), commands.head.subarray(commands.end)]);
  return prefixed(head, commands.reader);
}

/** Whether `ref` is one of the workspace's saved branches, under `workspaceRefs`. */
function isWorkspaceRef(ref: string, workspaceRefs: string): boolean {
  return ref.startsWith(`${workspaceRefs}/`) && ref.length > workspaceRefs.length + 1;
}

/**
 * Why a push's ref updates are refused, or null. Only branches and tags may be pushed, and `main`, which
 * is what people see, may not be deleted; the workspace's own saved branches may be set or removed freely.
 */
function refusedRefUpdate(updates: readonly RefUpdate[], workspaceRefs: string): string | null {
  for (const update of updates) {
    if (isWorkspaceRef(update.ref, workspaceRefs)) {
      continue;
    }
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
  return gitPushReport(
    'ok',
    updates.map((update) => ({ ref: update.ref, refused: reason })),
    capabilities,
    reason,
  );
}

/**
 * A receive-pack answer of CloudChef's own: `unpack`, then each ref updated (`refused` null) or refused, in the
 * side-band the push asked for, with `note` as a progress line git prints.
 */
function gitPushReport(
  unpack: string,
  refs: readonly { ref: string; refused: string | null }[],
  capabilities: Set<string>,
  note: string | null,
): Response {
  const report = concatBytes([
    pktLine(`unpack ${unpack}\n`),
    ...refs.map(({ ref, refused }) => pktLine(refused === null ? `ok ${ref}\n` : `ng ${ref} ${refused}\n`)),
    new TextEncoder().encode('0000'),
  ]);
  const sideBand = capabilities.has('side-band-64k') || capabilities.has('side-band');
  const body = sideBand
    ? concatBytes([
        bandLine(1, report),
        ...(note ? [bandLine(2, new TextEncoder().encode(`${note}\n`))] : []),
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
  /**
   * Whether `ancestor` is `commit` or in its history in the repository, or null when that can't be told
   * (the walk ran too long): a push moves main only when its old commit is one.
   */
  isAncestor(repo: string, ancestor: string, commit: string): Promise<boolean | null>;
  /**
   * The local secret files a push of `commit` brings that `base` doesn't hold, in any commit it brings, or any at all
   * when `base` is null; null when it brings too many commits to check (`ProjectRepositories.secretFilesPushed`).
   */
  secretFilesPushed(repo: string, base: string | null, commit: string): Promise<string[] | null>;
  /** The commit main is at, or null when there is no main yet: what a new branch is checked against. */
  mainHead(repo: string): Promise<string | null>;
  /** The workspace's saved branches' prefix (`workspaceRefsPrefix`): the only refs besides branches and tags it may write or see. */
  workspaceRefs: string;
  /** A branch or tag a push updated; never one of the workspace's saved branches. */
  recordPush(update: RefUpdate): Promise<void>;
  /** Where git in the next container starts: the branch and commit this one has checked out. */
  recordBase(base: { branch: string; commit: string }): Promise<void>;
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
  if (isBaseReport(request)) {
    return baseReport(request, deps);
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
  let capabilities = new Set<string>();
  // Each branch a push sets: its new commit goes to a ref of its own instead (`staged`), and the branch moves to it
  // afterwards only once that is checked (`moveStaged`): main only forward, and no branch onto a secret file.
  let staged: StagedUpdate[] = [];
  // An advertisement, or protocol v2's ls-refs, lists refs: other workspaces' are left out of it.
  let listsRefs = route.advertisement;
  if (write && !route.advertisement) {
    const decoded = decodedRequestBody(request);
    if (!decoded) {
      return new Response('A push needs a body.', { status: 400 });
    }
    try {
      const commands = await readReceivePackCommands(decoded);
      updates = commands.updates;
      capabilities = commands.capabilities;
      const refused = refusal ?? refusedRefUpdate(updates, deps.workspaceRefs);
      if (refused) {
        await commands.reader.cancel().catch(() => undefined);
        return gitRefusalReport(updates, commands.capabilities, refused);
      }
      staged = updates
        .filter((update) => update.ref.startsWith('refs/heads/') && update.newOid !== ZERO_OID)
        .map((update) => ({
          update,
          staged: { ref: `${INCOMING_REFS_ROOT}/${crypto.randomUUID()}`, oldOid: ZERO_OID, newOid: update.newOid },
        }));
      body = {
        stream: staged.length > 0 ? rewrittenPush(commands, staged) : prefixed(commands.head, commands.reader),
        decoded: true,
      };
    } catch (error) {
      if (error instanceof GitProxyRefusal) {
        return new Response(error.message, { status: 400 });
      }
      throw error;
    }
  } else if (refusal) {
    return new Response(refusal, { status: 403 });
  } else if (!route.advertisement) {
    const decoded = decodedRequestBody(request);
    if (decoded) {
      const first = await readFirstPktLine(decoded);
      listsRefs = first.line === 'command=ls-refs';
      body = { stream: first.body, decoded: true };
    }
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
  if (listsRefs) {
    try {
      return await filteredRefList(response, deps.workspaceRefs);
    } finally {
      deps.waitUntil(revoke());
    }
  }
  if (staged.length > 0) {
    try {
      return await stagedPush({ deps, repo, remote, response, updates, capabilities, staged });
    } finally {
      deps.waitUntil(revoke());
    }
  }
  return observedResponse(response, async (answer) => {
    deps.waitUntil(revoke());
    if (updates.length === 0 || !response.ok) {
      return;
    }
    try {
      const report = readPushReport(answer);
      for (const update of updates) {
        // Saving the workspace's branches publishes nothing.
        if (isWorkspaceRef(update.ref, deps.workspaceRefs)) {
          continue;
        }
        if (report.unpack === 'ok' && report.refs.get(update.ref)?.ok) {
          await deps.recordPush(update);
        }
      }
    } catch (error) {
      console.error('Unable to record a git push', error);
    }
  });
}

/**
 * Finishes a push whose branches went to staged refs instead: once the repository has their new commits, each
 * branch moves to its own only once that is checked (`moveStaged`), and only from the commit git read (a push in
 * between is not overwritten). The staged refs are then deleted. A branch is never pointed at a commit that
 * fails the checks, even for a moment, so nothing that builds from one ever sees it. git is answered with each
 * ref as it ended, under its own name.
 */
async function stagedPush(args: {
  deps: GitProxyDependencies;
  repo: string;
  remote: GitRemote;
  response: Response;
  updates: readonly RefUpdate[];
  capabilities: Set<string>;
  staged: readonly StagedUpdate[];
}): Promise<Response> {
  const { deps, repo, remote, response, updates, staged } = args;
  if (!response.ok) {
    return response;
  }
  const report = readPushReport(await boundedBytes(response, MAX_REPORT_BYTES));
  const unpacked = report.unpack === 'ok';
  const moves = new Map<RefUpdate, string | null>();
  // The first reason CloudChef itself gave, said again as a line git prints.
  let note: string | null = null;
  for (const { update, staged: landed } of staged) {
    const result = report.refs.get(landed.ref);
    let refused: string | null = result?.ok ? null : result?.reason || 'not updated';
    if (unpacked && result?.ok) {
      refused = await moveStaged(deps, repo, remote, update);
      note ??= refused;
      const removed = await updateRemoteRef(
        deps.fetch,
        remote,
        { ref: landed.ref, oldOid: landed.newOid, newOid: ZERO_OID },
        new Uint8Array(),
      ).catch(() => null);
      if (!removed?.ok) {
        console.error('Unable to delete a push’s staged ref');
      }
    }
    moves.set(update, refused);
  }
  const refs = updates.map((update) => {
    const moved = moves.get(update);
    if (moved !== undefined) {
      return { ref: update.ref, refused: unpacked ? moved : 'unpacker error' };
    }
    const result = report.refs.get(update.ref);
    if (!result) {
      return { ref: update.ref, refused: 'not updated' };
    }
    return { ref: update.ref, refused: unpacked && result.ok ? null : result.ok ? 'unpacker error' : result.reason };
  });
  try {
    for (const [index, update] of updates.entries()) {
      // Saving the workspace's branches publishes nothing.
      if (refs[index]?.refused === null && !isWorkspaceRef(update.ref, deps.workspaceRefs)) {
        await deps.recordPush(update);
      }
    }
  } catch (error) {
    console.error('Unable to record a git push', error);
  }
  return gitPushReport(report.unpack ?? 'error', refs, args.capabilities, unpacked ? note : null);
}

/**
 * Moves a branch from `update`'s old commit to its new one, once the repository has the new one: main only when
 * that adds to main's history, and any branch only when no commit the push brings holds a secret file that the
 * branch's old commit doesn't, or, for a new branch, that main doesn't (no secret file at all, for main's own first
 * push). Why it wasn't moved, or null when it was.
 */
async function moveStaged(
  deps: GitProxyDependencies,
  repo: string,
  remote: GitRemote,
  update: RefUpdate,
): Promise<string | null> {
  const created = update.oldOid === ZERO_OID;
  const isMain = update.ref === MAIN_REF;
  if (isMain && !created) {
    const fastForward = await deps.isAncestor(repo, update.oldOid, update.newOid).catch(() => null);
    if (fastForward === null) {
      return 'CloudChef couldn’t check this push against main. Try again.';
    }
    if (!fastForward) {
      return MAIN_REWRITE_REFUSAL;
    }
  }
  // A secret file reaches no branch, whichever computer the push came from: every branch is the project's, shared
  // with everyone on it, and main is what gets published.
  const base = created ? (isMain ? null : await deps.mainHead(repo).catch(() => undefined)) : update.oldOid;
  const secrets =
    base === undefined ? undefined : await deps.secretFilesPushed(repo, base, update.newOid).catch(() => undefined);
  if (secrets === undefined) {
    return isMain
      ? 'CloudChef couldn’t check this push against main. Try again.'
      : 'CloudChef couldn’t check this push. Try again.';
  }
  if (secrets === null) {
    return PUSH_TOO_LONG_REFUSAL;
  }
  if (secrets[0] !== undefined) {
    return secretFileRefusal(secrets[0]);
  }
  // From `oldOid` only: if the branch moved since git read it, the repository refuses this, as it would git's own push.
  const moved = await updateRemoteRef(deps.fetch, remote, update, await emptyPack()).catch(() => null);
  return moved?.ok ? null : (moved?.reason ?? 'The branch could not be updated. Try again.');
}

/** Why main can't take a commit holding the secret file `path`, whichever way it would get there. */
export function secretFileRefusal(path: string): string {
  return `${path} holds secrets and can't be pushed: remove it from your commits. Secrets belong in Cloudflare (the Worker's secrets or Secrets Store, set with cf).`;
}

/**
 * What the control plane is told of a push a team project's main took (`runtime-projects/main-pushed`): main's
 * commit before (null for its first push) and after. Null for anything else: another branch, a person's own app
 * (no team project), or main's deletion, which is refused anyway.
 */
export function mainPushReport(
  orgProjectId: string | null,
  update: RefUpdate,
): { orgProjectId: string; oldCommit: string | null; newCommit: string } | null {
  if (!orgProjectId || update.ref !== MAIN_REF || update.newOid === ZERO_OID) {
    return null;
  }
  return {
    orgProjectId,
    oldCommit: update.oldOid === ZERO_OID ? null : update.oldOid,
    newCommit: update.newOid,
  };
}

/** A pack with no objects:what a ref update the repository already has every object for sends. */
async function emptyPack(): Promise<Uint8Array> {
  const header = concatBytes([new TextEncoder().encode('PACK'), Uint8Array.of(0, 0, 0, 2, 0, 0, 0, 0)]);
  return concatBytes([header, new Uint8Array(await crypto.subtle.digest('SHA-1', header))]);
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

function isBaseReport(request: Request): boolean {
  const url = new URL(request.url);
  return url.hostname === GIT_PROXY_HOST && request.method === 'POST' && url.pathname === GIT_BASE_PATH;
}

/**
 * The branch and commit git in the container has checked out, told after a push that left the repository
 * holding that commit: where git in the next container starts. Only someone who may push says it.
 */
async function baseReport(request: Request, deps: GitProxyDependencies): Promise<Response> {
  const target = await deps.repository();
  if (await gitRefusal(deps, target, true)) {
    return new Response(null, { status: 403 });
  }
  const match = /^([A-Za-z0-9._/-]{1,255}) ([0-9a-f]{40})$/.exec((await request.text()).trim());
  if (!match || match[1]!.includes('..')) {
    return new Response(null, { status: 400 });
  }
  await deps.recordBase({ branch: match[1]!, commit: match[2]! });
  return new Response(null, { status: 204 });
}

/**
 * What git in a new container sets itself up from, as lines its shell setup reads: the branch and commit
 * the workspace's files match (`-` for none yet), the author's name and email, then where the workspace's
 * branches are saved in the repository.
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
    deps.workspaceRefs,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** A request's first pkt-line, where protocol v2 names its command (null when it has none), and the whole body again. */
type FirstPktLine = { line: string | null; body: ReadableStream<Uint8Array> };

async function readFirstPktLine(body: ReadableStream<Uint8Array>): Promise<FirstPktLine> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let buffered = new Uint8Array();
  for (;;) {
    if (buffered.length >= 4) {
      const length = Number.parseInt(new TextDecoder().decode(buffered.subarray(0, 4)), 16);
      if (!Number.isFinite(length) || length < 4) {
        return { line: null, body: prefixed(buffered, reader) };
      }
      if (buffered.length >= length) {
        const line = new TextDecoder().decode(buffered.subarray(4, length)).replace(/\n$/, '');
        return { line, body: prefixed(buffered, reader) };
      }
    }
    const { done, value } = await reader.read();
    if (done) {
      return { line: null, body: prefixed(buffered, reader) };
    }
    chunks.push(value);
    buffered = concatBytes(chunks);
  }
}

/** Whether a listed ref is shown to the workspace: HEAD, branches, tags, and its own saved branches. */
function visibleRef(ref: string, workspaceRefs: string): boolean {
  return (
    ref === 'HEAD' ||
    ref === 'capabilities^{}' ||
    /^refs\/(heads|tags)\//.test(ref) ||
    isWorkspaceRef(ref, workspaceRefs)
  );
}

/**
 * `response`'s ref list (an advertisement, or v2's ls-refs) with only the refs the workspace is shown, so no
 * member sees another workspace's saved branches. Capabilities a left-out v0 ref carried move to the next
 * ref kept, or to a `capabilities^{}` line when none is.
 */
async function filteredRefList(response: Response, workspaceRefs: string): Promise<Response> {
  if (!response.ok) {
    return response;
  }
  const bytes = await boundedBytes(response, MAX_REF_LIST_BYTES);
  const kept: Uint8Array[] = [];
  let capabilities: string | null = null;
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(offset, offset + 4)), 16);
    if (!Number.isFinite(length)) {
      break;
    }
    if (length < 4) {
      if (capabilities !== null) {
        kept.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
        capabilities = null;
      }
      kept.push(bytes.subarray(offset, offset + 4));
      offset += 4;
      continue;
    }
    const packet = bytes.subarray(offset, offset + length);
    offset += length;
    const text = new TextDecoder().decode(packet.subarray(4)).replace(/\n$/, '');
    const ref = /^[0-9a-f]{40} ([^ \0]+)/.exec(text)?.[1];
    if (ref === undefined) {
      kept.push(packet);
      continue;
    }
    const [listed = '', offered] = text.split('\0');
    if (!visibleRef(ref, workspaceRefs)) {
      capabilities = offered ?? capabilities;
    } else if (capabilities !== null && offered === undefined) {
      kept.push(pktLine(`${listed}\0${capabilities}\n`));
      capabilities = null;
    } else {
      kept.push(packet);
    }
  }
  kept.push(bytes.subarray(offset));
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(concatBytes(kept), { status: response.status, headers });
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
