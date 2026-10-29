import type { BuilderWorkspaceFileInput } from '@cloudchef/user-workspace-runtime/protocol';
import { WORK_DIR } from 'cloudchef-agent/constants';
import { BUILDER_TEMPLATE_GZIP_BASE64 } from './builder-template.generated';
import type { WorkspaceSeedExpectation } from './builder-workspace-api';
import { z } from 'zod';
import { base64ToBytes } from '~/lib/hex-digest';
import {
  MAIN_BRANCH,
  type ProjectRepositories,
  type RepositoryAuthor,
} from '~/lib/.server/cloudflare/project-repository';

let cachedTemplate: Promise<BuilderWorkspaceFileInput[]> | undefined;

/** The message of a new project's first commit, which people see as its first version. */
export const STARTING_PROJECT_MESSAGE = 'The starting project';

/**
 * Makes the first commit on main of a new project's repository: the whole template its workspace is seeded
 * with, so the history starts from the project as it began and every later commit holds only what changed.
 * A repository whose main already exists (a fork, or this ran before) is left as it is.
 */
export async function commitBuilderTemplate(
  repositories: ProjectRepositories,
  repo: string,
  author: RepositoryAuthor,
): Promise<void> {
  const template = await loadBuilderTemplate();
  const encoder = new TextEncoder();
  await repositories.commitFiles({
    repo,
    branch: MAIN_BRANCH,
    parent: null,
    files: template.map((entry) => ({
      path: entry.path.slice(`${WORK_DIR}/`.length),
      mode: entry.mode ?? 0o644,
      bytes: (entry.encoding ?? 'utf8') === 'utf8' ? encoder.encode(entry.content) : base64ToBytes(entry.content),
    })),
    message: STARTING_PROJECT_MESSAGE,
    author,
  });
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

const builderTemplateSchema = z.array(
  z.object({
    path: z.string(),
    content: z.string(),
    encoding: z.enum(['utf8', 'base64']),
  }),
);

async function decodeBuilderTemplate(): Promise<BuilderWorkspaceFileInput[]> {
  const compressed = base64ToBytes(BUILDER_TEMPLATE_GZIP_BASE64);
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  return builderTemplateSchema.parse(JSON.parse(await new Response(stream).text()));
}
