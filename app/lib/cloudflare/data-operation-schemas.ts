import { z } from 'zod';

export const MAX_SUBCHAT_INDEX = 10_000;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 200;
const identifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);
const descriptionSchema = z.string().max(MAX_DESCRIPTION_LENGTH);
const subchatIndexSchema = z.number().int().nonnegative().max(MAX_SUBCHAT_INDEX);
const chatIdentityArgsSchema = z.object({ id: identifierSchema });
const chatArgsSchema = z.object({ chatId: identifierSchema });
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);
/** A project is named by its chat (the person's own, or a team project's conversation) or by its team project. */
const projectRefSchema = z.union([
  z.object({ chatInitialId: identifierSchema }),
  z.object({ orgProjectId: z.string().uuid() }),
]);
const MAX_HISTORY_PAGE = 100;

/** The arguments each data operation takes; the runtime adds the signed-in user's id as `sessionId`. */
export const dataOperationArgSchemas = {
  'messages.initializeChat': chatIdentityArgsSchema,
  'messages.openLinkedChat': chatIdentityArgsSchema.extend({ orgProjectId: z.string().uuid() }),
  'messages.startLinkedChat': chatIdentityArgsSchema.extend({ orgProjectId: z.string().uuid() }),
  'messages.linkedChatHistory': z.object({ orgProjectId: z.string().uuid() }),
  'messages.discardEmptyChat': chatIdentityArgsSchema,
  'messages.get': chatIdentityArgsSchema,
  'messages.getAll': z.object({}),
  'messages.setDescription': chatIdentityArgsSchema.extend({ description: descriptionSchema }),
  'messages.remove': chatIdentityArgsSchema,
  'projects.history': z.intersection(
    projectRefSchema,
    z.object({
      limit: z.number().int().positive().max(MAX_HISTORY_PAGE),
      offset: z.number().int().nonnegative(),
    }),
  ),
  'projects.cloneAccess': projectRefSchema,
  'projects.fork': z.object({ chatInitialId: identifierSchema, commit: commitSchema }),
  'projects.import': z.object({ url: z.string().url().max(2_048), name: descriptionSchema.trim().optional() }),
  'subchats.get': chatArgsSchema,
  'subchats.create': chatArgsSchema,
  'subchats.setDescription': chatArgsSchema.extend({
    subchatIndex: subchatIndexSchema,
    description: descriptionSchema.trim().min(1),
  }),
} as const;
