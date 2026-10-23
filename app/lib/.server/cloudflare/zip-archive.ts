import { concatBytes } from './repository-wire';

/**
 * A ZIP archive written as a stream, one file at a time: each is read, deflated, and sent before the
 * next is read, so an archive of a project never sits in memory whole. No ZIP64: a project is far
 * under its 4 GB limits (`BUILDER_WORKSPACE_MAX_TOTAL_BYTES`).
 */

export type ZipEntry = { path: string; mode: number; read: () => Promise<Uint8Array<ArrayBuffer>> };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** DOS date and time for the archive's entries: one fixed moment, so the same commit zips the same. */
function dosDateTime(date: Date) {
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/** Streams `entries` as a ZIP archive; `modifiedAt` stamps every entry (the commit's time). */
export function zipStream(entries: readonly ZipEntry[], modifiedAt: Date): ReadableStream<Uint8Array> {
  const stamp = dosDateTime(modifiedAt);
  const central: Uint8Array[] = [];
  let offset = 0;
  let count = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const entry = entries[count];
      if (!entry) {
        const directory = concatBytes(central);
        controller.enqueue(directory);
        controller.enqueue(endOfCentralDirectory(count, directory.length, offset));
        controller.close();
        return;
      }
      const name = new TextEncoder().encode(entry.path);
      const raw = await entry.read();
      const compressed = await deflateRaw(raw);
      const crc = crc32(raw);
      const local = header(0x04034b50, 30, name, (view) => {
        view.setUint16(4, 20, true);
        view.setUint16(6, 0x0800, true);
        view.setUint16(8, 8, true);
        view.setUint16(10, stamp.time, true);
        view.setUint16(12, stamp.date, true);
        view.setUint32(14, crc, true);
        view.setUint32(18, compressed.length, true);
        view.setUint32(22, raw.length, true);
        view.setUint16(26, name.length, true);
      });
      central.push(
        header(0x02014b50, 46, name, (view) => {
          // Made by Unix (3), so the mode in the external attributes counts: executables stay executable.
          view.setUint16(4, (3 << 8) | 20, true);
          view.setUint16(6, 20, true);
          view.setUint16(8, 0x0800, true);
          view.setUint16(10, 8, true);
          view.setUint16(12, stamp.time, true);
          view.setUint16(14, stamp.date, true);
          view.setUint32(16, crc, true);
          view.setUint32(20, compressed.length, true);
          view.setUint32(24, raw.length, true);
          view.setUint16(28, name.length, true);
          view.setUint32(38, ((0o100000 | (entry.mode & 0o777)) << 16) >>> 0, true);
          view.setUint32(42, offset, true);
        }),
      );
      offset += local.length + compressed.length;
      count += 1;
      controller.enqueue(local);
      controller.enqueue(compressed);
    },
  });
}

function header(signature: number, size: number, name: Uint8Array, fill: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(size + name.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, signature, true);
  fill(view);
  bytes.set(name, size);
  return bytes;
}

function endOfCentralDirectory(count: number, size: number, offset: number): Uint8Array {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  return bytes;
}
