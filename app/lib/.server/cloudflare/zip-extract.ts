import { crc32 } from './zip-archive';

/**
 * The files of a ZIP archive someone uploaded, read from its central directory: stored and deflated
 * entries only, no encryption, no ZIP64. Every size is checked as the bytes are inflated, so an archive
 * that claims less than it holds is cut off rather than held whole. Folders, symbolic links, a `.git`
 * folder and the files macOS adds (`__MACOSX/`, `.DS_Store`) are left out, and when every file is inside
 * one top-level folder (as in GitHub's Download ZIP) that folder is taken away.
 */

type ZipLimits = { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };

type ExtractedFile = { path: string; mode: number; bytes: Uint8Array<ArrayBuffer> };

/** `too_large`: past a limit; `invalid`: not an archive CloudChef can read. Both are said to the person as is. */
export class ZipReadError extends Error {
  constructor(
    message: string,
    readonly code: 'too_large' | 'invalid',
  ) {
    super(message);
    this.name = 'ZipReadError';
  }
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
/** The end record is 22 bytes, followed by a comment of at most 65,535. */
const MAX_END_SEARCH = 22 + 0xffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const HOST_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

type CentralEntry = {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  mode: number;
};

export async function extractZip(archive: Uint8Array, limits: ZipLimits): Promise<ExtractedFile[]> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const entries = readCentralDirectory(archive, view);
  const kept = entries.filter((entry) => !skipped(entry));
  if (kept.length === 0) {
    throw new ZipReadError('The ZIP has no files in it.', 'invalid');
  }
  if (kept.length > limits.maxFiles) {
    throw new ZipReadError(`The ZIP has more than ${limits.maxFiles.toLocaleString('en')} files.`, 'too_large');
  }
  const prefix = commonFolder(kept.map((entry) => entry.name));
  const files: ExtractedFile[] = [];
  const paths = new Set<string>();
  let total = 0;
  for (const entry of kept) {
    const path = entry.name.slice(prefix.length);
    if (paths.has(path)) {
      throw new ZipReadError(`The ZIP has ${quoted(path)} in it twice.`, 'invalid');
    }
    paths.add(path);
    if (entry.size > limits.maxFileBytes) {
      throw new ZipReadError(`${quoted(path)} is larger than ${megabytes(limits.maxFileBytes)}.`, 'too_large');
    }
    total += entry.size;
    if (total > limits.maxTotalBytes) {
      throw new ZipReadError(
        `The files in the ZIP add up to more than ${megabytes(limits.maxTotalBytes)}.`,
        'too_large',
      );
    }
    // Executable or not is all a project keeps of a file's mode.
    const mode = (entry.mode & 0o111) !== 0 ? 0o755 : 0o644;
    files.push({ path, mode, bytes: await readEntry(archive, view, entry, path) });
  }
  for (const path of paths) {
    // A file and a folder of the same name can't both be in a project.
    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
      if (paths.has(path.slice(0, slash))) {
        throw new ZipReadError(
          `The ZIP has both a file and a folder named ${quoted(path.slice(0, slash))}.`,
          'invalid',
        );
      }
    }
  }
  return files;
}

function readCentralDirectory(archive: Uint8Array, view: DataView): CentralEntry[] {
  const end = findEndOfCentralDirectory(view);
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw new ZipReadError(MAKE_AGAIN_ZIP64, 'invalid');
  }
  if (offset + size > end) {
    throw new ZipReadError(NOT_A_ZIP, 'invalid');
  }
  const entries: CentralEntry[] = [];
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL_FILE_HEADER) {
      throw new ZipReadError(NOT_A_ZIP, 'invalid');
    }
    const madeBy = view.getUint16(at + 4, true);
    const flags = view.getUint16(at + 8, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const external = view.getUint32(at + 38, true);
    const nameBytes = archive.subarray(at + 46, at + 46 + nameLength);
    // Names not marked UTF-8 are CP437 by the format, but every current tool writes ASCII or UTF-8.
    const name = new TextDecoder('utf-8', { fatal: (flags & FLAG_UTF8) !== 0 }).decode(nameBytes);
    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new ZipReadError('The ZIP is password-protected. Upload one without a password.', 'invalid');
    }
    const unixMode = madeBy >> 8 === HOST_UNIX ? external >>> 16 : 0;
    entries.push({
      name: name.replace(/\\/g, '/'),
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
      mode: unixMode,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - MAX_END_SEARCH);
  for (let at = view.byteLength - 22; at >= lowest; at -= 1) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) {
      return at;
    }
  }
  throw new ZipReadError(NOT_A_ZIP, 'invalid');
}

/** Folders, links, git's own folder and macOS's additions aren't project files. */
function skipped(entry: CentralEntry): boolean {
  const type = entry.mode & S_IFMT;
  if (entry.name.endsWith('/') || type === S_IFDIR || type === S_IFLNK) {
    return true;
  }
  const segments = entry.name.split('/');
  if (entry.name.startsWith('/') || /^[A-Za-z]:/.test(entry.name) || segments.some(unsafeSegment)) {
    throw new ZipReadError(`The ZIP has a file outside its own folder (${quoted(entry.name)}).`, 'invalid');
  }
  return segments[0] === '__MACOSX' || segments.includes('.git') || segments.at(-1) === '.DS_Store';
}

function unsafeSegment(segment: string): boolean {
  return segment === '' || segment === '.' || segment === '..';
}

/** `name/` when every path is inside the folder `name`, otherwise nothing. */
function commonFolder(paths: readonly string[]): string {
  const [first] = paths;
  const slash = first?.indexOf('/') ?? -1;
  if (slash === -1) {
    return '';
  }
  const folder = first!.slice(0, slash + 1);
  return paths.every((path) => path.startsWith(folder)) ? folder : '';
}

async function readEntry(
  archive: Uint8Array,
  view: DataView,
  entry: CentralEntry,
  path: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const at = entry.localOffset;
  if (at + 30 > archive.byteLength || view.getUint32(at, true) !== LOCAL_FILE_HEADER) {
    throw new ZipReadError(NOT_A_ZIP, 'invalid');
  }
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const stored = archive.subarray(start, start + entry.compressedSize);
  if (stored.length !== entry.compressedSize) {
    throw new ZipReadError(NOT_A_ZIP, 'invalid');
  }
  let bytes: Uint8Array<ArrayBuffer>;
  if (entry.method === METHOD_STORED) {
    bytes = new Uint8Array(stored);
  } else if (entry.method === METHOD_DEFLATED) {
    bytes = await inflate(stored, entry.size, path);
  } else {
    throw new ZipReadError(`${quoted(path)} is compressed in a way CloudChef can't read. ${MAKE_AGAIN}`, 'invalid');
  }
  if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) {
    throw new ZipReadError(`${quoted(path)} is damaged in the ZIP.`, 'invalid');
  }
  return bytes;
}

/** Inflates a deflated entry, stopping as soon as it holds more than it said. */
async function inflate(stored: Uint8Array, size: number, path: string): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([new Uint8Array(stored)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader();
  const bytes = new Uint8Array(size);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (length + value.length > size) {
        await reader.cancel().catch(() => undefined);
        throw new ZipReadError(`${quoted(path)} is damaged in the ZIP.`, 'invalid');
      }
      bytes.set(value, length);
      length += value.length;
    }
  } catch (error) {
    if (error instanceof ZipReadError) {
      throw error;
    }
    throw new ZipReadError(`${quoted(path)} is damaged in the ZIP.`, 'invalid');
  }
  return length === size ? bytes : bytes.slice(0, length);
}

const NOT_A_ZIP = "That file isn't a ZIP CloudChef can read, or it's damaged.";
const MAKE_AGAIN = "Make the ZIP again with your computer's own Compress option.";
const MAKE_AGAIN_ZIP64 = `This ZIP is in a format for very large archives that CloudChef can't read. ${MAKE_AGAIN}`;

function quoted(path: string): string {
  return `“${path.slice(0, 200)}”`;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
