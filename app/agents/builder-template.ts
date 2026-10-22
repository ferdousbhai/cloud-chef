import type { BuilderWorkspaceFileInput } from './builder-workspace-types';
import { BUILDER_TEMPLATE_GZIP_BASE64, BUILDER_TEMPLATE_SOURCE_SHA256 } from './builder-template.generated';
import type { WorkspaceSeedExpectation } from './builder-workspace-api';
import { z } from 'zod';
import { base64ToBytes } from '~/lib/hex-digest';

let cachedTemplate: Promise<BuilderWorkspaceFileInput[]> | undefined;

export function builderTemplateSeedId(): string {
  return `template_${BUILDER_TEMPLATE_SOURCE_SHA256}`;
}

export function loadBuilderTemplate(): Promise<BuilderWorkspaceFileInput[]> {
  cachedTemplate ??= decodeBuilderTemplate();
  return cachedTemplate;
}

function decodedBytes(entry: BuilderWorkspaceFileInput): number {
  if ((entry.encoding ?? 'utf8') === 'utf8') {
    return new TextEncoder().encode(entry.content).byteLength;
  }
  const padding = entry.content.endsWith('==') ? 2 : entry.content.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((entry.content.length * 3) / 4) - padding);
}

export function builderTemplateTotals(entries: BuilderWorkspaceFileInput[]): WorkspaceSeedExpectation {
  return {
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + decodedBytes(entry), 0),
  };
}

const builderTemplateFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']),
});

async function decodeBuilderTemplate(): Promise<BuilderWorkspaceFileInput[]> {
  const compressed = base64ToBytes(BUILDER_TEMPLATE_GZIP_BASE64);
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const json = new TextDecoder().decode(await new Response(stream).arrayBuffer());
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error('The bundled Builder template is invalid.');
  }
  const files: unknown[] = parsed;
  return files.map((file) => {
    const entry = builderTemplateFileSchema.safeParse(file);
    if (!entry.success) {
      throw new Error('The bundled Builder template contains an invalid file.');
    }
    return entry.data;
  });
}
