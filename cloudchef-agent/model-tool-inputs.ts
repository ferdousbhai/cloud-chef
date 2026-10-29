import { z, type ZodType } from 'zod';
import { editToolParameters } from './file-edit.js';

const pathSchema = z.object({ path: z.string() });

/**
 * The model's four tools, all against the durable project workspace. `read` is answered from the Durable
 * Object's SQLite VFS alone: it takes no exclusive operation lane and never wakes the Container. The others
 * change the project or run in its Container, under that lane.
 *
 * Everything else the agent does is a command `exec` runs, and what a command may reach outside the container
 * is decided where it leaves it (the workspace's git and Cloudflare API proxies), not by a tool of its own.
 */
export const MODEL_TOOL_NAMES = ['read', 'write', 'edit', 'exec'] as const;
export type ModelToolName = (typeof MODEL_TOOL_NAMES)[number];

export function isWorkspaceReadOnlyToolName(name: string): name is 'read' {
  return name === 'read';
}

/** Complete model-facing contracts for every tool the model may call. */
export const MODEL_TOOL_INPUT_SCHEMAS = {
  read: pathSchema.extend({
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  }),
  write: pathSchema.extend({ content: z.string() }),
  edit: editToolParameters,
  exec: z.object({
    command: z.string(),
    cwd: z.string().optional(),
  }),
} as const satisfies Record<ModelToolName, ZodType>;
