import { builderTranscriptBindingsEqual, type BuilderTranscriptBinding } from './builder-request-policy';

type BuilderIdentityStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

type BuilderIdentityRow = {
  user_id: string;
  agent_name: string;
  chat_initial_id: string;
  subchat_index: number;
  parent_agent_name: string | null;
};

/** The person whose chat this is, who alone uses the agent, and the transcript it serves. */
export type ConversationAgentDurableIdentity = {
  userId: string;
  transcript: BuilderTranscriptBinding;
};

/**
 * Owns the immutable authorization and transcript identity for one ConversationAgent.
 * The record lives in the Agent's own SQLite database so hibernation and fiber
 * recovery never depend on connection props being replayed.
 */
export class ConversationAgentIdentityRepository {
  constructor(private readonly storage: BuilderIdentityStorage) {}

  get(): ConversationAgentDurableIdentity | null {
    const row = [
      ...this.storage.sql.exec<BuilderIdentityRow>(`
        SELECT user_id, agent_name, chat_initial_id, subchat_index, parent_agent_name
        FROM builder_identity
        WHERE id = 'active'
        LIMIT 1
      `),
    ][0];
    return row ? fromRow(row) : null;
  }

  /** Claim once, or prove an exact replay of the original durable identity. */
  claim(identity: ConversationAgentDurableIdentity): ConversationAgentDurableIdentity {
    return this.storage.transactionSync(() => {
      const current = this.get();
      if (current) {
        if (!conversationAgentIdentitiesEqual(current, identity)) {
          throw new ConversationAgentIdentityMismatchError();
        }
        return current;
      }
      this.storage.sql.exec(
        `INSERT INTO builder_identity (
           id, owner_id, user_id, agent_name, chat_initial_id, generation,
           subchat_index, parent_agent_name, created_at
         ) VALUES ('active', ?, ?, ?, ?, 0, ?, ?, ?)`,
        identity.userId,
        identity.userId,
        identity.transcript.agentName,
        identity.transcript.chatInitialId,
        identity.transcript.conversationIndex,
        identity.transcript.parentAgentName,
        new Date().toISOString(),
      );
      return identity;
    });
  }
}

export class ConversationAgentIdentityMismatchError extends Error {
  constructor() {
    super('ConversationAgent durable identity mismatch.');
    this.name = 'ConversationAgentIdentityMismatchError';
  }
}

export function conversationAgentIdentitiesEqual(
  left: ConversationAgentDurableIdentity,
  right: ConversationAgentDurableIdentity,
): boolean {
  return left.userId === right.userId && builderTranscriptBindingsEqual(left.transcript, right.transcript);
}

function fromRow(row: BuilderIdentityRow): ConversationAgentDurableIdentity {
  return {
    userId: row.user_id,
    transcript: {
      agentName: row.agent_name,
      chatInitialId: row.chat_initial_id,
      conversationIndex: row.subchat_index,
      parentAgentName: row.parent_agent_name,
    },
  };
}
