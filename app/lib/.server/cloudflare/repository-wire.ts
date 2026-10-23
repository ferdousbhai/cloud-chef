/**
 * Git's smart HTTP push, as little of it as CloudChef needs: read a repository's refs, and send one ref
 * update with a pack of the objects it adds. Artifacts has no server-side commit or merge, so commits,
 * merges and resets are written in the Worker and pushed this way. Every update names the value the ref
 * had when it was read, so a ref someone else moved meanwhile is refused rather than overwritten.
 */

/** Git's id for a ref that doesn't exist: the old value of a ref being created. */
export const ZERO_OID = '0'.repeat(40);

const PUSH_TIMEOUT_MS = 2 * 60_000;
const MAX_ADVERTISEMENT_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024;

export type GitFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Credentials for one repository's remote: its https address and a token's secret. */
export type GitRemote = { url: string; secret: string };

type RefUpdateResult = { ok: true } | { ok: false; reason: string };

/** HTTP Basic credentials git sends: any user name, the token's secret as the password. */
function gitBasicAuthorization(secret: string): string {
  return `Basic ${btoa(`x:${secret}`)}`;
}

/** The token's secret: Artifacts appends `?expires=<unix>` to a token, which git must not send. */
export function tokenSecret(token: string): string {
  return token.split('?')[0] ?? token;
}

/** The repository's refs as its receive-pack service advertises them, by full name. */
export async function readRemoteRefs(fetchGit: GitFetch, remote: GitRemote): Promise<Map<string, string>> {
  const response = await fetchGit(`${remote.url}/info/refs?service=git-receive-pack`, {
    headers: { authorization: gitBasicAuthorization(remote.secret), 'git-protocol': 'version=1' },
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`The repository could not be read (HTTP ${response.status}).`);
  }
  const body = await boundedBytes(response, MAX_ADVERTISEMENT_BYTES);
  const refs = new Map<string, string>();
  for (const line of readPktLines(body)) {
    const text = new TextDecoder().decode(line).replace(/\n$/, '');
    if (text.startsWith('#')) {
      continue;
    }
    const [head] = text.split('\0');
    const match = /^([0-9a-f]{40}) (\S+)$/.exec(head ?? '');
    if (match && match[1] !== ZERO_OID && match[2] !== 'capabilities^{}') {
      refs.set(match[2]!, match[1]!);
    }
  }
  return refs;
}

/**
 * Moves `ref` from `oldOid` to `newOid` (ZERO_OID creates it), sending `pack`, which must hold every
 * object the new value adds. The server refuses it when the ref is no longer `oldOid`.
 */
export async function updateRemoteRef(
  fetchGit: GitFetch,
  remote: GitRemote,
  update: { ref: string; oldOid: string; newOid: string },
  pack: Uint8Array,
): Promise<RefUpdateResult> {
  const command = pktLine(`${update.oldOid} ${update.newOid} ${update.ref}\0report-status agent=cloudchef\n`);
  const body = new Uint8Array(command.length + 4 + pack.length);
  body.set(command);
  body.set(new TextEncoder().encode('0000'), command.length);
  body.set(pack, command.length + 4);
  const response = await fetchGit(`${remote.url}/git-receive-pack`, {
    method: 'POST',
    headers: {
      authorization: gitBasicAuthorization(remote.secret),
      'content-type': 'application/x-git-receive-pack-request',
      accept: 'application/x-git-receive-pack-result',
    },
    body,
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: `HTTP ${response.status}` };
  }
  return readReport(await boundedBytes(response, MAX_REPORT_BYTES), update.ref);
}

/** The push's report-status: the pack unpacked, and the ref updated, or why not. Side-band is unwrapped. */
function readReport(body: Uint8Array, ref: string): RefUpdateResult {
  let lines = [...readPktLines(body)];
  if (lines[0]?.[0] === 1) {
    const inner = lines.filter((line) => line[0] === 1).map((line) => line.subarray(1));
    lines = [...readPktLines(concatBytes(inner))];
  }
  const texts = lines.map((line) => new TextDecoder().decode(line).replace(/\n$/, ''));
  const unpack = texts.find((text) => text.startsWith('unpack '));
  if (unpack && unpack !== 'unpack ok') {
    return { ok: false, reason: unpack };
  }
  if (texts.includes(`ok ${ref}`)) {
    return { ok: true };
  }
  const refused = texts.find((text) => text.startsWith(`ng ${ref}`));
  return { ok: false, reason: refused?.slice(`ng ${ref}`.length).trim() || 'the update was not reported' };
}

function pktLine(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const length = (payload.length + 4).toString(16).padStart(4, '0');
  return concatBytes([new TextEncoder().encode(length), payload]);
}

/** The payloads of git's pkt-lines (a flush or delimiter line has none and is skipped). */
function* readPktLines(bytes: Uint8Array): Generator<Uint8Array> {
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(offset, offset + 4)), 16);
    if (!Number.isFinite(length)) {
      return;
    }
    if (length < 4) {
      offset += 4;
      continue;
    }
    yield bytes.subarray(offset + 4, offset + length);
    offset += length;
  }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function boundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new Error('The repository answered with more than expected.');
  }
  return bytes;
}
