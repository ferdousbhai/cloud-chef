/** One regular file from a tarball, its path relative to the archive's top-level directory. */
type TarEntry = { path: string; bytes: Uint8Array; executable: boolean };

const BLOCK = 512;

/**
 * The regular files of a gzipped tarball as GitHub serves a commit (`owner-repo-sha/…`), read as a
 * stream so a repository never has to fit in memory at once. Directories and links are skipped; pax and
 * GNU long names are honored.
 */
export async function* readRepositoryTarball(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
): AsyncGenerator<TarEntry> {
  const input = new ByteQueue(stream.pipeThrough(new DecompressionStream('gzip')).getReader());
  let longName: string | null = null;
  for (;;) {
    const header = await input.read(BLOCK);
    if (!header || header.every((byte) => byte === 0)) {
      return;
    }
    const size = parseOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 48);
    const content = await input.read(size);
    await input.read((BLOCK - (size % BLOCK)) % BLOCK);
    if (!content) {
      throw new Error('The repository download ended early.');
    }
    if (type === 'x') {
      longName = paxPath(content) ?? longName;
      continue;
    }
    if (type === 'L') {
      longName = text(content).replace(/\0+$/, '');
      continue;
    }
    const name = longName ?? joinUstarName(header);
    longName = null;
    if (type !== '0') {
      continue;
    }
    const path = name.split('/').slice(1).join('/');
    if (!path) {
      continue;
    }
    const mode = parseOctal(header.subarray(100, 108));
    yield { path, bytes: content, executable: (mode & 0o111) !== 0 };
  }
}

function joinUstarName(header: Uint8Array): string {
  const name = text(header.subarray(0, 100)).replace(/\0.*$/s, '');
  const prefix = text(header.subarray(345, 500)).replace(/\0.*$/s, '');
  return prefix ? `${prefix}/${name}` : name;
}

/** The `path` record of a pax extended header ("<length> path=<value>\n" records). */
function paxPath(content: Uint8Array): string | null {
  for (const record of text(content).split('\n')) {
    const match = /^\d+ path=(.*)$/s.exec(record);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function parseOctal(field: Uint8Array): number {
  const value = text(field).replace(/[\0 ]+/g, '');
  return value ? Number.parseInt(value, 8) : 0;
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Reads exact byte counts from a stream of arbitrarily sized chunks. */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private done = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** The next `length` bytes, or null when the stream ends first. */
  async read(length: number): Promise<Uint8Array | null> {
    while (this.buffered < length && !this.done) {
      const next = await this.reader.read();
      if (next.done) {
        this.done = true;
      } else {
        this.chunks.push(next.value);
        this.buffered += next.value.length;
      }
    }
    if (this.buffered < length) {
      return null;
    }
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.length, length - offset);
      out.set(chunk.subarray(0, take), offset);
      offset += take;
      if (take === chunk.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(take);
      }
    }
    this.buffered -= length;
    return out;
  }
}
