import { z } from 'zod';
import { PayloadTooLargeError, readBodyBytesWithLimit } from '~/lib/bounded-body';
import { commitPathRefusal } from './commit-paths';

/**
 * The most a draft's files may decompress to. The request holds at most 1.5 MB of gzip, which could
 * otherwise inflate to gigabytes; this is checked while decompressing, before anything is buffered past it.
 */
const MAX_DRAFT_SNAPSHOT_JSON_BYTES = 24 * 1024 * 1024;

const snapshotSchema = z.array(z.object({ path: z.string().min(1), contentBase64: z.string().refine(isBase64) }));
const projectFileSchema = z.looseObject({
  name: z.string().optional(),
  d1: z.looseObject({ name: z.string().optional() }).optional(),
  r2: z.looseObject({ name: z.string().optional() }).optional(),
});

type DraftFile = z.infer<typeof snapshotSchema>[number];
type ProjectFile = z.infer<typeof projectFileSchema>;

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
 * A draft's files, from the gzipped JSON `[{ path, contentBase64 }]` its request carries, or null when
 * it holds anything else; `refused`, saying why, when GitHub would refuse to commit them. Read when the
 * member's runtime sends the request, so such a draft is refused then, and again before an approval
 * creates anything on GitHub. A draft that inflates past the limit throws `PayloadTooLargeError`.
 */
export async function readDraftSnapshot(
  snapshotGzipBase64: string,
): Promise<{ files: DraftFile[] } | { refused: string } | null> {
  try {
    const bytes = await readBodyBytesWithLimit(
      new Response(new Blob([base64Bytes(snapshotGzipBase64)]).stream().pipeThrough(new DecompressionStream('gzip'))),
      MAX_DRAFT_SNAPSHOT_JSON_BYTES,
      "The draft's files",
    );
    const parsed = snapshotSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success) {
      return null;
    }
    const refused = commitPathRefusal(parsed.data.map((file) => file.path));
    return refused ? { refused } : { files: parsed.data };
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      throw error;
    }
    // Not base64, not gzip, or not JSON.
    return null;
  }
}

/**
 * The first commit of a promoted draft: its files, with its Cloudflare resources renamed from the
 * draft's to the app's own, so its repository's pipeline provisions and deploys it as a real app
 * (the template's `pnpm run deploy` creates what it names).
 */
export function promotedDraftFiles(
  files: DraftFile[],
  workerName: string,
): { path: string; contentBase64: string | null; executable: boolean }[] {
  return files.map((file) => ({
    path: file.path,
    contentBase64:
      file.path === 'cloudflare.project.json' ? renameResources(file.contentBase64, workerName) : file.contentBase64,
    executable: false,
  }));
}

/** The project file with the app's names, or as it was when it isn't one CloudChef can read. */
function renameResources(contentBase64: string, workerName: string): string {
  const parsed = projectFile(contentBase64);
  if (!parsed) {
    return contentBase64;
  }
  const project = { ...parsed, name: workerName };
  if (parsed.d1) {
    project.d1 = { ...parsed.d1, name: workerName };
  }
  if (parsed.r2) {
    project.r2 = { ...parsed.r2, name: `${workerName}-storage` };
  }
  const text = `${JSON.stringify(project, null, 2)}\n`;
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function projectFile(contentBase64: string): ProjectFile | null {
  try {
    const parsed = projectFileSchema.safeParse(JSON.parse(new TextDecoder().decode(base64Bytes(contentBase64))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isBase64(value: string): boolean {
  try {
    atob(value);
    return true;
  } catch {
    return false;
  }
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
