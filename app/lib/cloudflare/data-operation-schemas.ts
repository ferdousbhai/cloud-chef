import { z } from 'zod';
import { MAX_DATA_PAGE_SIZE, MAX_SUBCHAT_INDEX } from './data-pagination';

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 200;
const identifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);
const descriptionSchema = z.string().max(MAX_DESCRIPTION_LENGTH);
const subchatIndexSchema = z.number().int().nonnegative().max(MAX_SUBCHAT_INDEX);
const sessionIdArgsSchema = z.object({ sessionId: identifierSchema });
const chatIdentityArgsSchema = z.object({ sessionId: identifierSchema, id: identifierSchema });
const chatArgsSchema = z.object({ sessionId: identifierSchema, chatId: identifierSchema });
const pageLimitSchema = z.number().int().min(1).max(MAX_DATA_PAGE_SIZE).optional();
const chatHistoryCursorSchema = z
  .object({
    timestamp: z.string().datetime({ precision: 3 }),
    rowId: identifierSchema,
  })
  .strict()
  .optional();
const subchatCursorSchema = z.object({ subchatIndex: subchatIndexSchema }).strict().optional();

export const dataOperationArgSchemas = {
  'messages.initializeChat': chatIdentityArgsSchema,
  'messages.openLinkedChat': chatIdentityArgsSchema.extend({ orgProjectId: z.string().uuid() }),
  'messages.startLinkedChat': chatIdentityArgsSchema.extend({ orgProjectId: z.string().uuid() }),
  'messages.linkedChatHistory': sessionIdArgsSchema.extend({ orgProjectId: z.string().uuid() }),
  'messages.discardEmptyChat': chatIdentityArgsSchema,
  'messages.get': chatIdentityArgsSchema,
  'messages.getAll': sessionIdArgsSchema.extend({ cursor: chatHistoryCursorSchema, limit: pageLimitSchema }),
  'messages.setDescription': chatIdentityArgsSchema.extend({ description: descriptionSchema }),
  'messages.remove': chatIdentityArgsSchema,
  'subchats.get': chatArgsSchema.extend({ cursor: subchatCursorSchema, limit: pageLimitSchema }),
  'subchats.create': chatArgsSchema,
  'subchats.setDescription': chatArgsSchema.extend({
    subchatIndex: subchatIndexSchema,
    description: descriptionSchema.trim().min(1),
  }),
} as const;
