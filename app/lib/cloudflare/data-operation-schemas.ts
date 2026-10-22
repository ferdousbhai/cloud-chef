import { z } from 'zod';

export const MAX_SUBCHAT_INDEX = 10_000;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 200;
const identifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);
const descriptionSchema = z.string().max(MAX_DESCRIPTION_LENGTH);
const subchatIndexSchema = z.number().int().nonnegative().max(MAX_SUBCHAT_INDEX);
const sessionIdArgsSchema = z.object({ sessionId: identifierSchema });
const chatIdentityArgsSchema = z.object({ sessionId: identifierSchema, id: identifierSchema });
const chatArgsSchema = z.object({ sessionId: identifierSchema, chatId: identifierSchema });

export const dataOperationArgSchemas = {
  'messages.initializeChat': chatIdentityArgsSchema,
  'messages.openLinkedChat': chatIdentityArgsSchema.extend({ orgProjectId: z.string().uuid() }),
  'messages.startLinkedChat': chatIdentityArgsSchema.extend({ orgProjectId: z.string().uuid() }),
  'messages.linkedChatHistory': sessionIdArgsSchema.extend({ orgProjectId: z.string().uuid() }),
  'messages.discardEmptyChat': chatIdentityArgsSchema,
  'messages.get': chatIdentityArgsSchema,
  'messages.getAll': sessionIdArgsSchema,
  'messages.setDescription': chatIdentityArgsSchema.extend({ description: descriptionSchema }),
  'messages.remove': chatIdentityArgsSchema,
  'subchats.get': chatArgsSchema,
  'subchats.create': chatArgsSchema,
  'subchats.setDescription': chatArgsSchema.extend({
    subchatIndex: subchatIndexSchema,
    description: descriptionSchema.trim().min(1),
  }),
} as const;
