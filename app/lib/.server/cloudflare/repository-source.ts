import { boundedBytes, concatBytes, pktLine, readPktLines, type GitFetch } from './repository-wire';

/**
 * A repository elsewhere (GitHub) read over git's smart HTTP, protocol version 2, as an import needs it:
 * which commit a branch is at, and that branch's whole history as one pack, handed on as it arrives so a
 * large repository never sits in memory. The pack is what `git clone --single-branch --no-tags` receives;
 * the repository it is pushed into checks it whole (its checksum and every object it names) before any
 * ref moves, so a copy cut off partway leaves nothing behind.
 */

/** Where to read from: an https address, and an `Authorization` header value for a private repository. */
export type GitSource = { url: string; authorization: string | null };

/** `no_repository`: the host has no repository at that address, or (GitHub, for a private one) won't say. */
type GitSourceFailure = 'auth_required' | 'no_repository' | 'not_found' | 'too_large' | 'unavailable';

export class GitSourceError extends Error {
  constructor(
    readonly reason: GitSourceFailure,
    message: string,
  ) {
    super(message);
    this.name = 'GitSourceError';
  }
}

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ADVERTISEMENT_BYTES = 256 * 1024;
const MAX_LS_REFS_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
/** pkt-line lengths below 4 are markers: flush, delimiter, and response end. */
const FLUSH = 0;
const BAND_DATA = 1;
const BAND_PROGRESS = 2;
const BAND_ERROR = 3;

/** The commit a branch of the source is at; without a branch, the one its HEAD names. */
export async function readSourceBranch(fetchGit: GitFetch, source: GitSource, branch: string | null): Promise<string> {
  const advertisement = await sourceRequest(fetchGit, source, '/info/refs?service=git-upload-pack', {});
  const lines = [...readPktLines(await boundedBytes(advertisement, MAX_ADVERTISEMENT_BYTES))].map(text);
  if (!lines.includes('version 2')) {
    throw new GitSourceError('unavailable', "the repository's host does not speak git's protocol version 2");
  }
  const wanted = branch ? `refs/heads/${branch}` : null;
  const body = concatBytes([
    pktLine('command=ls-refs\n'),
    delimiter(),
    pktLine(wanted ? `ref-prefix ${wanted}\n` : 'ref-prefix HEAD\n'),
    flush(),
  ]);
  const response = await sourceRequest(fetchGit, source, '/git-upload-pack', { body });
  for (const line of readPktLines(await boundedBytes(response, MAX_LS_REFS_BYTES))) {
    const [oid = '', name = ''] = text(line).split(' ');
    if (!/^[0-9a-f]{40}$/.test(oid)) {
      continue;
    }
    // HEAD counts whether it names a branch or is detached: only the commit is copied.
    if (name === (wanted ?? 'HEAD')) {
      return oid;
    }
  }
  throw new GitSourceError(
    'not_found',
    branch ? `the repository has no branch ${branch.slice(0, 256)}` : 'the repository has no commits',
  );
}

/** A pack as it arrives from the source, and why it broke off, once it has. */
type SourcePack = { stream: ReadableStream<Uint8Array>; failure: () => GitSourceError | null };

/**
 * Everything `oid` reaches, as the pack the source sends, read only as fast as it is passed on. The stream
 * fails, and `failure()` says why, when the source reports an error, stops before the pack ends, or sends
 * more than `maxBytes`.
 */
export async function fetchSourcePack(
  fetchGit: GitFetch,
  source: GitSource,
  oid: string,
  options: { ofsDelta: boolean; maxBytes: number; timeoutMs: number },
): Promise<SourcePack> {
  const body = concatBytes([
    pktLine('command=fetch\n'),
    delimiter(),
    pktLine(`want ${oid}\n`),
    ...(options.ofsDelta ? [pktLine('ofs-delta\n')] : []),
    pktLine('no-progress\n'),
    pktLine('done\n'),
    flush(),
  ]);
  const response = await sourceRequest(fetchGit, source, '/git-upload-pack', { body, timeoutMs: options.timeoutMs });
  if (!response.body) {
    throw new GitSourceError('unavailable', "the repository's host sent no history");
  }
  return demultiplexPack(response.body, options.maxBytes);
}

/**
 * The pack inside an upload-pack answer: past its other sections to `packfile`, then side-band band 1
 * (band 2 is progress, band 3 an error), until the flush that ends it.
 */
function demultiplexPack(body: ReadableStream<Uint8Array>, maxBytes: number): SourcePack {
  const reader = body.getReader();
  let buffer: Uint8Array = new Uint8Array(0);
  let inPack = false;
  let sent = 0;
  let failed: GitSourceError | null = null;

  /** Whether `length` bytes are buffered, reading more until they are or the answer ends. */
  async function fill(length: number): Promise<boolean> {
    while (buffer.length < length) {
      const next = await reader.read();
      if (next.done) {
        return false;
      }
      buffer = buffer.length ? concatBytes([buffer, next.value]) : next.value;
    }
    return true;
  }

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const fail = (error: GitSourceError) => {
          failed = error;
          controller.error(error);
          void reader.cancel(error).catch(() => undefined);
        };
        try {
          for (;;) {
            if (!(await fill(4))) {
              fail(new GitSourceError('unavailable', 'the copy stopped before the whole history arrived'));
              return;
            }
            const length = Number.parseInt(new TextDecoder().decode(buffer.subarray(0, 4)), 16);
            if (!Number.isFinite(length) || length === 3) {
              fail(new GitSourceError('unavailable', "the repository's host answered with something other than git"));
              return;
            }
            if (length < 4) {
              buffer = buffer.subarray(4);
              if (length === FLUSH) {
                if (inPack) {
                  controller.close();
                } else {
                  fail(new GitSourceError('unavailable', "the repository's host sent no history"));
                }
                return;
              }
              continue;
            }
            if (!(await fill(length))) {
              fail(new GitSourceError('unavailable', 'the copy stopped before the whole history arrived'));
              return;
            }
            const payload = buffer.subarray(4, length);
            buffer = buffer.subarray(length);
            if (!inPack) {
              const line = text(payload);
              if (line.startsWith('ERR ')) {
                fail(new GitSourceError('unavailable', `the repository's host refused: ${line.slice(4, 204)}`));
                return;
              }
              inPack = line === 'packfile';
              continue;
            }
            const band = payload[0];
            if (band === BAND_DATA) {
              sent += payload.length - 1;
              if (sent > maxBytes) {
                fail(new GitSourceError('too_large', 'the history is larger than a project holds'));
                return;
              }
              controller.enqueue(payload.subarray(1));
              return;
            }
            if (band === BAND_ERROR) {
              fail(
                new GitSourceError(
                  'unavailable',
                  `the repository's host stopped: ${text(payload.subarray(1)).slice(0, 200)}`,
                ),
              );
              return;
            }
            if (band !== BAND_PROGRESS) {
              fail(new GitSourceError('unavailable', "the repository's host answered with something other than git"));
              return;
            }
          }
        } catch (error) {
          // The source's connection broke or timed out.
          fail(
            new GitSourceError(
              'unavailable',
              `the copy stopped before the whole history arrived (${error instanceof Error ? error.name : 'error'})`,
            ),
          );
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, failure: () => failed };
}

/**
 * One request to the source's git service. Its credential goes in a header, never the address, and only to
 * the source's own origin: a redirect elsewhere is refused rather than followed with it.
 */
async function sourceRequest(
  fetchGit: GitFetch,
  source: GitSource,
  path: string,
  options: { body?: Uint8Array<ArrayBuffer>; timeoutMs?: number },
): Promise<Response> {
  const base = source.url.replace(/\/+$/, '');
  const origin = new URL(base).origin;
  const headers = new Headers({ 'git-protocol': 'version=2', 'user-agent': 'git/cloudchef' });
  if (source.authorization) {
    headers.set('authorization', source.authorization);
  }
  if (options.body) {
    headers.set('content-type', 'application/x-git-upload-pack-request');
    headers.set('accept', 'application/x-git-upload-pack-result');
  }
  let url = `${base}${path}`;
  for (let redirects = 0; ; redirects += 1) {
    let response: Response;
    try {
      response = await fetchGit(url, {
        method: options.body ? 'POST' : 'GET',
        headers,
        body: options.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GitSourceError(
        'unavailable',
        `the repository's host could not be reached (${error instanceof Error ? error.name : 'error'})`,
      );
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => undefined);
      const next = new URL(location, url);
      if (next.origin !== origin || redirects >= MAX_REDIRECTS) {
        throw new GitSourceError('unavailable', "the repository's address moves somewhere CloudChef does not follow");
      }
      url = next.href;
      continue;
    }
    if (response.ok) {
      return response;
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      throw new GitSourceError('auth_required', `the repository's host refused access (HTTP ${response.status})`);
    }
    if (response.status === 404) {
      throw new GitSourceError('no_repository', 'the repository was not found');
    }
    throw new GitSourceError('unavailable', `the repository's host answered HTTP ${response.status}`);
  }
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\n$/, '');
}

function delimiter(): Uint8Array {
  return new TextEncoder().encode('0001');
}

function flush(): Uint8Array {
  return new TextEncoder().encode('0000');
}
