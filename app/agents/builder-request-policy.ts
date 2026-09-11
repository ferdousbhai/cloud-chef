import { transcriptIdentitySchema, type TranscriptIdentity } from 'ghostbuild-agent/transcript';
import { MAX_USER_MESSAGE_CHARACTERS } from 'ghostbuild-agent/context-limits';
import type { UIMessage } from 'ai';
import { workersAiModelIdSchema, type WorkersAiModelId } from '~/lib/workers-ai-model';
import { z } from 'zod';

const MAX_BUILDER_AGENT_NAME_LENGTH = 512;
const MAX_BUILDER_SUBCHAT_INDEX = 10_000;

export type BuilderTranscriptBinding = {
  agentName: string;
  chatInitialId: string;
  generation: number;
  subchatIndex: number;
  parentAgentName: string | null;
};

export function builderTranscriptBindingsEqual(
  left: BuilderTranscriptBinding,
  right: BuilderTranscriptBinding,
): boolean {
  return (
    left.agentName === right.agentName &&
    left.chatInitialId === right.chatInitialId &&
    left.generation === right.generation &&
    left.subchatIndex === right.subchatIndex &&
    left.parentAgentName === right.parentAgentName
  );
}

type BuilderTranscriptRow = {
  agent_name: string;
  initial_id: string;
  generation: number;
  subchat_index: number;
  parent_agent_name: string | null;
};

/** Resolve the durable Agent name to the active, owner-scoped D1 transcript it represents. */
export async function loadBuilderTranscriptBinding(
  db: D1Database,
  args: { agentName: string; ownerId: string },
): Promise<BuilderTranscriptBinding | null> {
  const row = await db
    .prepare(
      `SELECT transcripts.agent_name,
              chats.initial_id,
              transcripts.generation,
              transcripts.subchat_index,
              parent.agent_name AS parent_agent_name
       FROM chat_transcripts AS transcripts
       INNER JOIN chats ON chats.id = transcripts.chat_id
       LEFT JOIN chat_transcripts AS parent
         ON parent.chat_id = transcripts.chat_id
        AND parent.subchat_index = transcripts.parent_subchat_index
        AND parent.generation = transcripts.parent_generation
       WHERE transcripts.agent_name = ?
         AND chats.creator_id = ?
         AND chats.is_deleted = 0
       LIMIT 1`,
    )
    .bind(args.agentName, args.ownerId)
    .first<BuilderTranscriptRow>();

  return row
    ? {
        agentName: row.agent_name,
        chatInitialId: row.initial_id,
        generation: row.generation,
        subchatIndex: row.subchat_index,
        parentAgentName: row.parent_agent_name ?? null,
      }
    : null;
}

/** The chat request fields the builder scope check reads. Every one arrives unvalidated from the client. */
type BuilderChatRequestBody = {
  chatInitialId?: unknown;
  subchatIndex?: unknown;
  transcript?: unknown;
  modelId?: unknown;
};

type BuilderRequestScope = {
  chatInitialId: string;
  subchatIndex: number;
  transcript: TranscriptIdentity;
  modelId: WorkersAiModelId;
};

const chatInitialIdSchema = z.string().min(1).max(MAX_BUILDER_AGENT_NAME_LENGTH);
const subchatIndexSchema = z.number().int().min(0).max(MAX_BUILDER_SUBCHAT_INDEX);

export function requireBuilderRequestScope(
  body: BuilderChatRequestBody,
  binding: BuilderTranscriptBinding | null,
): BuilderRequestScope {
  const chatInitialId = chatInitialIdSchema.safeParse(body.chatInitialId);
  if (!chatInitialId.success) {
    throw new Response('Invalid initial chat identifier', { status: 400 });
  }
  const subchatIndex = subchatIndexSchema.safeParse(body.subchatIndex);
  if (!subchatIndex.success) {
    throw new Response('Invalid subchat index', { status: 400 });
  }
  const transcript = requireBuilderTranscriptIdentity(body.transcript, binding, subchatIndex.data);
  const modelId = workersAiModelIdSchema.safeParse(body.modelId);
  if (!modelId.success) {
    throw new Response('Invalid builder model', { status: 400 });
  }
  if (chatInitialId.data !== binding?.chatInitialId) {
    throw new Response('Initial chat identifier does not match this transcript', { status: 409 });
  }
  return {
    chatInitialId: chatInitialId.data,
    subchatIndex: subchatIndex.data,
    transcript,
    modelId: modelId.data,
  };
}

export function requireBuilderTranscriptIdentity(
  value: unknown,
  binding: BuilderTranscriptBinding | null,
  selectedSubchatIndex?: number,
): TranscriptIdentity {
  const result = transcriptIdentitySchema.safeParse(value);
  if (!result.success) {
    throw new Response('Invalid transcript identity', { status: 400 });
  }
  if (
    !binding ||
    result.data.agentName !== binding.agentName ||
    result.data.generation !== binding.generation ||
    result.data.subchatIndex !== binding.subchatIndex
  ) {
    throw new Response('Transcript identity does not match this agent', { status: 409 });
  }
  if (selectedSubchatIndex !== undefined && result.data.subchatIndex !== selectedSubchatIndex) {
    throw new Response('Transcript identity does not match the selected subchat', { status: 409 });
  }
  return result.data;
}

/** Keep direct Agent clients from persisting prompt text beyond the product's supported input size. */
export function boundBuilderMessageForPersistence(message: UIMessage): UIMessage {
  if (message.role !== 'user') {
    return message;
  }
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.type === 'text' && part.text.length > MAX_USER_MESSAGE_CHARACTERS
        ? { ...part, text: part.text.slice(0, MAX_USER_MESSAGE_CHARACTERS) }
        : part,
    ),
  };
}
