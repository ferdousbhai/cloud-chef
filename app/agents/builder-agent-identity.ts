import { builderTranscriptBindingsEqual, type BuilderTranscriptBinding } from './builder-request-policy';

type BuilderIdentityStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

type BuilderIdentityRow = {
  owner_id: string;
  user_id: string;
  agent_name: string;
  chat_initial_id: string;
  generation: number;
  subchat_index: number;
  parent_agent_name: string | null;
};

export type BuilderAgentDurableIdentity = {
  ownerId: string;
  userId: string;
  transcript: BuilderTranscriptBinding;
};

/**
 * Owns the immutable authorization and transcript identity for one BuilderAgent.
 * The record lives in the Agent's own SQLite database so hibernation and fiber
 * recovery never depend on connection props being replayed.
 */
export class BuilderAgentIdentityRepository {
  constructor(private readonly storage: BuilderIdentityStorage) {}

  get(): BuilderAgentDurableIdentity | null {
    const row = [
      ...this.storage.sql.exec<BuilderIdentityRow>(`
        SELECT owner_id, user_id, agent_name, chat_initial_id, generation,
               subchat_index, parent_agent_name
        FROM builder_identity
        WHERE id = 'active'
        LIMIT 1
      `),
    ][0];
    return row ? fromRow(row) : null;
  }

  /** Claim once, or prove an exact replay of the original durable identity. */
  claim(identity: BuilderAgentDurableIdentity): BuilderAgentDurableIdentity {
    return this.storage.transactionSync(() => {
      const current = this.get();
      if (current) {
        if (!builderAgentIdentitiesEqual(current, identity)) {
          throw new BuilderAgentIdentityMismatchError();
        }
        return current;
      }
      this.storage.sql.exec(
        `INSERT INTO builder_identity (
           id, owner_id, user_id, agent_name, chat_initial_id, generation,
           subchat_index, parent_agent_name, created_at
         ) VALUES ('active', ?, ?, ?, ?, ?, ?, ?, ?)`,
        identity.ownerId,
        identity.userId,
        identity.transcript.agentName,
        identity.transcript.chatInitialId,
        identity.transcript.generation,
        identity.transcript.subchatIndex,
        identity.transcript.parentAgentName,
        new Date().toISOString(),
      );
      return identity;
    });
  }
}

export class BuilderAgentIdentityMismatchError extends Error {
  constructor() {
    super('BuilderAgent durable identity mismatch.');
    this.name = 'BuilderAgentIdentityMismatchError';
  }
}

export function builderAgentIdentitiesEqual(
  left: BuilderAgentDurableIdentity,
  right: BuilderAgentDurableIdentity,
): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.userId === right.userId &&
    builderTranscriptBindingsEqual(left.transcript, right.transcript)
  );
}

function fromRow(row: BuilderIdentityRow): BuilderAgentDurableIdentity {
  return {
    ownerId: row.owner_id,
    userId: row.user_id,
    transcript: {
      agentName: row.agent_name,
      chatInitialId: row.chat_initial_id,
      generation: row.generation,
      subchatIndex: row.subchat_index,
      parentAgentName: row.parent_agent_name,
    },
  };
}
