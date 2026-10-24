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
/** A project by its chat (a CloudChef app, or the team project it works on) or by its team project id. */
const projectTargetSchema = z.object({
  chatInitialId: identifierSchema.optional(),
  orgProjectId: z.string().min(1).max(256).optional(),
});
const oneProject = (args: z.infer<typeof projectTargetSchema>) =>
  (args.chatInitialId === undefined) !== (args.orgProjectId === undefined);
const ONE_PROJECT = { message: 'Name either a chat or a project.' };

/** The arguments each data operation takes; the runtime adds the signed-in user's id as `sessionId`. */
export const dataOperationArgSchemas = {
  'messages.initializeChat': chatIdentityArgsSchema,
  'messages.openLinkedChat': chatIdentityArgsSchema.extend({ orgProjectId: z.string().uuid() }),
  'messages.discardEmptyChat': chatIdentityArgsSchema,
  'messages.get': chatIdentityArgsSchema,
  'messages.getAll': z.object({}),
  'messages.setDescription': chatIdentityArgsSchema.extend({ description: descriptionSchema }),
  'messages.remove': chatIdentityArgsSchema,
  'subchats.get': chatArgsSchema,
  'subchats.create': chatArgsSchema,
  'subchats.setDescription': chatArgsSchema.extend({
    subchatIndex: subchatIndexSchema,
    description: descriptionSchema.trim().min(1),
  }),
  'projects.history': projectTargetSchema
    .extend({
      limit: z.number().int().min(1).max(100).default(30),
      offset: z.number().int().min(0).max(100_000).default(0),
    })
    .refine(oneProject, ONE_PROJECT),
  'projects.cloneAccess': projectTargetSchema.refine(oneProject, ONE_PROJECT),
  'projects.fork': projectTargetSchema.extend({ commit: commitSchema }).refine(oneProject, ONE_PROJECT),
  'projects.import': z.object({
    url: z.url({ protocol: /^https$/ }).max(2048),
    name: z.string().trim().min(1).max(100).optional(),
  }),
} as const;
