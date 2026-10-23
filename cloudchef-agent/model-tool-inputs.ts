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
const WORKSPACE_READ_ONLY_TOOL_NAMES = ['read', 'ls', 'grep'] as const;

/** Workspace tools that mutate the project or run in its Container, under the exclusive operation lane. */
const WORKSPACE_MUTATING_TOOL_NAMES = ['write', 'edit', 'exec', 'validate'] as const;

/** Tools executed against the durable project workspace. */
export const WORKSPACE_TOOL_NAMES = [...WORKSPACE_READ_ONLY_TOOL_NAMES, ...WORKSPACE_MUTATING_TOOL_NAMES] as const;
export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];
type WorkspaceReadOnlyToolName = (typeof WORKSPACE_READ_ONLY_TOOL_NAMES)[number];

/** Cloudflare API tools, offered when the turn has the account's runtime identity behind it. They never enter the workspace operation lane. */
const CLOUDFLARE_API_MODEL_TOOL_NAMES = ['cloudflare_request'] as const;
export type CloudflareApiModelToolName = (typeof CLOUDFLARE_API_MODEL_TOOL_NAMES)[number];

/** Tools for a workspace opened from a team project: changes are committed to its repository. */
const LINKED_PROJECT_MODEL_TOOL_NAMES = ['publish_preview', 'publish', 'fetch_site'] as const;
export type LinkedProjectModelToolName = (typeof LINKED_PROJECT_MODEL_TOOL_NAMES)[number];

export const MODEL_TOOL_NAMES = [
  ...WORKSPACE_TOOL_NAMES,
  'search_cloudflare_docs',
  ...CLOUDFLARE_API_MODEL_TOOL_NAMES,
  ...LINKED_PROJECT_MODEL_TOOL_NAMES,
] as const;
export type ModelToolName = (typeof MODEL_TOOL_NAMES)[number];
export type AlwaysAvailableModelToolName = Exclude<
  ModelToolName,
  CloudflareApiModelToolName | LinkedProjectModelToolName
>;

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
    path: z
      .string()
      .optional()
      .describe('Absolute project directory, or one file, to list. Defaults to the project root.'),
    recursive: z.boolean().optional().describe('List the whole tree beneath the directory instead of its contents.'),
    limit: z.number().int().min(1).optional().describe('Maximum entries to return.'),
  }),
  grep: z.object({
    pattern: z.string().min(1).describe('Literal single-line text to find. Not a regular expression or glob.'),
    path: z
      .string()
      .optional()
      .describe('Absolute project directory, or one file, to search. Defaults to the project root.'),
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
  publish_preview: z.object({
    message: z
      .string()
      .min(1)
      .max(500)
      .describe('A short commit message saying what changed, for the project history.'),
  }),
  publish: z.object({
    message: z
      .string()
      .min(1)
      .max(500)
      .describe('A short commit message saying what changed, for the project history.'),
  }),
  fetch_site: z.object({
    url: z
      .string()
      .min(1)
      .max(2_048)
      .describe("An https address on the project's live site or one of its preview links, with any path and query."),
    format: z
      .enum(['text', 'html'])
      .optional()
      .describe('text (the default) strips an HTML page to its readable text; html returns the markup as served.'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Character offset to continue a long response from: the previous result's nextCursor."),
  }),
} as const satisfies Record<ModelToolName, ZodType>;
