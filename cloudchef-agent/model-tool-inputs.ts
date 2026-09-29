import { z, type ZodType } from 'zod';
import { cloudflareApiRequestInputSchema } from './cloudflare-api.js';
import { lineEditToolParameters } from './line-edit.js';

const pathSchema = z.object({ path: z.string() });

/**
 * Workspace tools answered from the Durable Object's SQLite VFS alone.
 *
 * They take no exclusive operation lane and never wake the Container, so discovery stays
 * available while a build command holds the lane and answers before the container is warm.
 */
export const WORKSPACE_READ_ONLY_TOOL_NAMES = ['read', 'ls', 'grep'] as const;

/** Workspace tools that mutate the project or run in its Container, under the exclusive operation lane. */
const WORKSPACE_MUTATING_TOOL_NAMES = ['write', 'edit', 'exec', 'validate'] as const;

/** Tools executed against the durable project workspace. */
export const WORKSPACE_TOOL_NAMES = [...WORKSPACE_READ_ONLY_TOOL_NAMES, ...WORKSPACE_MUTATING_TOOL_NAMES] as const;
export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];
export type WorkspaceReadOnlyToolName = (typeof WORKSPACE_READ_ONLY_TOOL_NAMES)[number];

/** Cloudflare API tools, admitted per turn by runtime controls. They never enter the workspace operation lane. */
export const CLOUDFLARE_API_MODEL_TOOL_NAMES = ['cloudflare_request'] as const;
export type CloudflareApiModelToolName = (typeof CLOUDFLARE_API_MODEL_TOOL_NAMES)[number];

export const MODEL_TOOL_NAMES = [
  ...WORKSPACE_TOOL_NAMES,
  'search_cloudflare_docs',
  ...CLOUDFLARE_API_MODEL_TOOL_NAMES,
] as const;
export type ModelToolName = (typeof MODEL_TOOL_NAMES)[number];
export type AlwaysAvailableModelToolName = Exclude<ModelToolName, CloudflareApiModelToolName>;

export function isWorkspaceReadOnlyToolName(name: string): name is WorkspaceReadOnlyToolName {
  return (WORKSPACE_READ_ONLY_TOOL_NAMES as readonly string[]).includes(name);
}

/** Complete model-facing contracts for every tool the model may call. */
export const MODEL_TOOL_INPUT_SCHEMAS = {
  read: pathSchema.extend({
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  }),
  ls: z.object({
    path: z.string().optional().describe('Absolute project directory. Defaults to the project root.'),
    recursive: z.boolean().optional().describe('List the whole tree beneath the directory instead of its contents.'),
    limit: z.number().int().min(1).optional().describe('Maximum entries to return.'),
  }),
  grep: z.object({
    pattern: z.string().min(1).describe('Literal single-line text to find. Not a regular expression or glob.'),
    path: z.string().optional().describe('Absolute project directory to search. Defaults to the project root.'),
    ignoreCase: z.boolean().optional().describe('Match without regard to letter case.'),
    limit: z.number().int().min(1).optional().describe('Maximum matches to return.'),
  }),
  write: pathSchema.extend({ content: z.string() }),
  edit: lineEditToolParameters,
  exec: z.object({
    command: z.string(),
    cwd: z.string().optional(),
  }),
  validate: z.object({}),
  search_cloudflare_docs: z.object({ query: z.string() }),
  // The model passes `cf <command> --dry-run` output through unchanged. The account is fixed by the
  // connection, so a URL naming any other account is rejected before a credential is resolved.
  cloudflare_request: cloudflareApiRequestInputSchema,
} as const satisfies Record<ModelToolName, ZodType>;
