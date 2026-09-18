import { z } from 'zod';
import { MAX_EPHEMERAL_CONTEXT_CHARACTERS } from './context-limits.js';

export const chatTurnContextSchema = z
  .object({
    version: z.literal(1),
    content: z.string().max(MAX_EPHEMERAL_CONTEXT_CHARACTERS),
  })
  .strict();

export type ChatTurnContext = z.infer<typeof chatTurnContextSchema>;
