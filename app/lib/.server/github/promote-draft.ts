import { z } from 'zod';
import { readBodyBytesWithLimit } from '~/lib/bounded-body';

/**
 * The most a draft's files may decompress to. The request holds at most 1.5 MB of gzip, which could
 * otherwise inflate to gigabytes; this is checked while decompressing, before anything is buffered past it.
 */
const MAX_DRAFT_SNAPSHOT_JSON_BYTES = 24 * 1024 * 1024;

const snapshotSchema = z.array(z.object({ path: z.string().min(1), contentBase64: z.string() }));
const projectFileSchema = z.looseObject({
  name: z.string().optional(),
  d1: z.looseObject({ name: z.string().optional() }).optional(),
  r2: z.looseObject({ name: z.string().optional() }).optional(),
});

/** The Worker name a promoted app deploys as: its repository's name, as Cloudflare accepts names. */
export function promotedWorkerName(repoName: string): string {
  const name = repoName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 54);
  return name || 'app';
}

/**
 * The first commit of a promoted draft: its files, with its Cloudflare resources renamed from the
 * draft's to the app's own, so its repository's pipeline provisions and deploys it as a real app
 * (the template's `pnpm run deploy` creates what it names).
 */
export async function promotedDraftFiles(
  snapshotGzipBase64: string,
  workerName: string,
): Promise<{ path: string; contentBase64: string | null; executable: boolean }[]> {
  const gzipped = Uint8Array.from(atob(snapshotGzipBase64), (char) => char.charCodeAt(0));
  const bytes = await readBodyBytesWithLimit(
    new Response(new Blob([gzipped]).stream().pipeThrough(new DecompressionStream('gzip'))),
    MAX_DRAFT_SNAPSHOT_JSON_BYTES,
    "The draft's files",
  );
  const json = new TextDecoder().decode(bytes);
  return snapshotSchema.parse(JSON.parse(json)).map((file) => ({
    path: file.path,
    contentBase64:
      file.path === 'cloudflare.project.json' ? renameResources(file.contentBase64, workerName) : file.contentBase64,
    executable: false,
  }));
}

function renameResources(contentBase64: string, workerName: string): string {
  const parsed = projectFileSchema.safeParse(JSON.parse(new TextDecoder().decode(base64Bytes(contentBase64))));
  if (!parsed.success) {
    return contentBase64;
  }
  const project = { ...parsed.data, name: workerName };
  if (parsed.data.d1) {
    project.d1 = { ...parsed.data.d1, name: workerName };
  }
  if (parsed.data.r2) {
    project.r2 = { ...parsed.data.r2, name: `${workerName}-storage` };
  }
  const text = `${JSON.stringify(project, null, 2)}\n`;
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
