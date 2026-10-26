import { describe, expect, it } from 'vitest';
import { zipStream, type ZipEntry } from './zip-archive';
import { extractZip, ZipReadError } from './zip-extract';

const limits = { maxFiles: 100, maxFileBytes: 1024, maxTotalBytes: 4096 };

/** A ZIP of `files`; `executable` names those with mode 755. */
async function zip(files: Record<string, string>, executable: readonly string[] = []): Promise<Uint8Array> {
  const entries: ZipEntry[] = Object.entries(files).map(([path, text]) => ({
    path,
    mode: executable.includes(path) ? 0o755 : 0o644,
    read: async () => new TextEncoder().encode(text),
  }));
  return new Uint8Array(await new Response(zipStream(entries, new Date('2026-10-26T00:00:00Z'))).arrayBuffer());
}

function decoded(files: Awaited<ReturnType<typeof extractZip>>) {
  return Object.fromEntries(
    files.map((file) => [file.path, { text: new TextDecoder().decode(file.bytes), mode: file.mode }]),
  );
}

describe('reading an uploaded ZIP', () => {
  it('takes away the one folder everything is in, keeps executables, and leaves out git and macOS files', async () => {
    const archive = await zip(
      {
        'site-main/index.html': '<h1>Hi</h1>',
        'site-main/bin/build.sh': 'echo',
        'site-main/.git/HEAD': 'ref: refs/heads/main',
        'site-main/.DS_Store': 'x',
        '__MACOSX/site-main/._index.html': 'x',
      },
      ['site-main/bin/build.sh'],
    );
    expect(decoded(await extractZip(archive, limits))).toEqual({
      'index.html': { text: '<h1>Hi</h1>', mode: 0o644 },
      'bin/build.sh': { text: 'echo', mode: 0o755 },
    });
  });

  it('keeps paths as they are when the files are not all in one folder', async () => {
    const archive = await zip({ 'package.json': '{}', 'src/index.ts': 'export {}' });
    expect(Object.keys(decoded(await extractZip(archive, limits)))).toEqual(['package.json', 'src/index.ts']);
  });

  it('refuses paths outside the project, damaged or foreign files, and archives past the limits', async () => {
    const refusal = (archive: Uint8Array, options = limits) => extractZip(archive, options).catch((error) => error);
    expect(await refusal(await zip({ '../escape.txt': 'x' }))).toMatchObject({ code: 'invalid' });
    expect(await refusal(new TextEncoder().encode('not a zip'))).toMatchObject({ code: 'invalid' });
    expect(await refusal(await zip({ 'a.txt': 'x'.repeat(2048) }))).toMatchObject({ code: 'too_large' });
    expect(await refusal(await zip({ 'a.txt': 'x', 'b.txt': 'y' }), { ...limits, maxFiles: 1 })).toMatchObject({
      code: 'too_large',
    });
    expect(await refusal(await zip({ '.git/HEAD': 'x' }))).toMatchObject({ message: 'The ZIP has no files in it.' });
    const damaged = await zip({ 'a.txt': 'hello hello hello' });
    // The first file's data starts after its 30-byte header and its name.
    damaged[30 + 'a.txt'.length] ^= 0xff;
    expect(await refusal(damaged)).toBeInstanceOf(ZipReadError);
  });

  it("leaves out git's folder by any name git refuses, and refuses names git can't keep", async () => {
    const files = await extractZip(
      await zip({ 'a.txt': 'a', '.GIT/config': 'x', '.git /HEAD': 'x', 'git~1/HEAD': 'x', 'sub/.Git./x': 'x' }),
      limits,
    );
    expect(files.map((file) => file.path)).toEqual(['a.txt']);
    await expect(extractZip(await zip({ 'a\u0001b.txt': 'x' }), limits)).rejects.toMatchObject({ code: 'invalid' });
  });
});
