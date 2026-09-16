const MAX_PERSISTED_TOOL_OPERATIONS = 500;
const MAX_PERSISTED_TOOL_CANCELLATIONS = 500;
const MAX_INDETERMINATE_TOOL_OPERATIONS = 50;
/**
 * Platform ceiling, not a product choice: a journal row lives in Durable Object SQLite, whose
 * per-value limit is 2 MiB, and a larger result simply cannot be persisted. It has to stay above
 * the exec tool's own per-channel caps so a legitimately noisy command is truncated by those
 * rather than rejected here.
 */
const MAX_TOOL_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_ERROR_LENGTH = 4_000;

import { acknowledgeMutationReceipt, isMutationReceipt, type MutationReceipt } from './mutation-receipt';
import { first } from './sql-rows';

type ToolOperationStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

type ToolOperationRow = {
  tool_name: string;
  args_sha256: string;
  status: 'running' | 'completed' | 'failed';
  result_json: string | null;
  error: string | null;
};

type PendingToolOperationRow = {
  tool_call_id: string;
  result_json: string;
};

type PendingCommandEnvelope = {
  kind: 'workspace-sync-pending';
  backend: string;
  result: unknown;
};

type PendingToolOperation = {
  backend: string;
  toolCallId: string;
  result: unknown;
};

export type ToolOperationStartResult =
  | { status: 'execute' | 'active' }
  | { status: 'completed'; result: unknown }
  | { status: 'failed'; error: string }
  | { status: 'indeterminate'; error: string };

export type ToolOperationCancellationResult = { status: 'active' | 'settled' };

export class ToolOperationJournal {
  constructor(private readonly storage: ToolOperationStorage) {}

  initialize(): void {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_tool_operations (
         tool_call_id TEXT PRIMARY KEY,
         tool_name TEXT NOT NULL,
         args_sha256 TEXT NOT NULL,
         status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
         result_json TEXT,
         error TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_tool_cancellations (
         tool_call_id TEXT PRIMARY KEY,
         error TEXT NOT NULL,
         cancelled_at INTEGER NOT NULL
       )`,
    );
  }

  begin(args: { toolCallId: string; toolName: string; argsSha256: string; now?: number }): ToolOperationStartResult {
    return this.storage.transactionSync(() => {
      const existing = this.read(args.toolCallId);
      if (existing) {
        assertSameInvocation(existing, args);
        return startResult(existing);
      }
      const cancellation = this.cancellation(args.toolCallId);
      if (cancellation) {
        const now = args.now ?? Date.now();
        this.storage.sql.exec(
          `INSERT INTO ghostbuild_tool_operations (
             tool_call_id, tool_name, args_sha256, status, result_json, error, created_at, updated_at
           ) VALUES (?, ?, ?, 'failed', NULL, ?, ?, ?)`,
          args.toolCallId,
          args.toolName,
          args.argsSha256,
          cancellation.error,
          now,
          now,
        );
        this.storage.sql.exec(`DELETE FROM ghostbuild_tool_cancellations WHERE tool_call_id = ?`, args.toolCallId);
        this.pruneTerminalOperations();
        return { status: 'failed', error: cancellation.error };
      }
      const running = first(
        this.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count
           FROM ghostbuild_tool_operations
           WHERE status = 'running'`,
        ),
      )?.count;
      if ((running ?? 0) >= MAX_INDETERMINATE_TOOL_OPERATIONS) {
        throw new Error('The workspace has too many indeterminate tool operations to safely start another.');
      }
      const now = args.now ?? Date.now();
      this.storage.sql.exec(
        `INSERT INTO ghostbuild_tool_operations (
           tool_call_id, tool_name, args_sha256, status, result_json, error, created_at, updated_at
         ) VALUES (?, ?, ?, 'running', NULL, NULL, ?, ?)`,
        args.toolCallId,
        args.toolName,
        args.argsSha256,
        now,
        now,
      );
      this.pruneTerminalOperations();
      return { status: 'execute' };
    });
  }

  complete(args: { toolCallId: string; result: unknown; now?: number }): unknown {
    const resultJson = encodeResult(args.result);
    return this.storage.transactionSync(() => {
      const existing = this.require(args.toolCallId);
      if (existing.status === 'running' && existing.error !== null) {
        throw new Error(existing.error);
      }
      if (existing.status === 'completed') {
        if (existing.result_json !== resultJson) {
          throw new Error('A completed workspace tool operation received a different result.');
        }
        return JSON.parse(existing.result_json);
      }
      if (existing.status === 'failed') {
        throw new Error(existing.error ?? 'The workspace tool operation failed.');
      }
      this.storage.sql.exec(
        `UPDATE ghostbuild_tool_operations
         SET status = 'completed', result_json = ?, error = NULL, updated_at = ?
         WHERE tool_call_id = ? AND status = 'running'`,
        resultJson,
        args.now ?? Date.now(),
        args.toolCallId,
      );
      this.pruneTerminalOperations();
      return JSON.parse(resultJson) as unknown;
    });
  }

  commitMutation(args: { toolCallId: string; receipt: MutationReceipt; now?: number }): MutationReceipt {
    const committed = this.complete({ toolCallId: args.toolCallId, result: args.receipt, now: args.now });
    if (!isMutationReceipt(committed)) {
      throw new Error('The completed workspace operation is not a mutation receipt.');
    }
    return committed;
  }

  acknowledgeMutation(args: { toolCallId: string; result: unknown; now?: number }): MutationReceipt {
    return this.storage.transactionSync(() => {
      const existing = this.require(args.toolCallId);
      if (existing.status !== 'completed' || existing.result_json === null) {
        throw new Error('The workspace mutation was not durably committed.');
      }
      const receipt: unknown = JSON.parse(existing.result_json);
      if (!isMutationReceipt(receipt)) {
        throw new Error('The completed workspace operation is not a mutation receipt.');
      }
      if (receipt.acknowledgement === 'complete') {
        return receipt;
      }
      const acknowledged = acknowledgeMutationReceipt(receipt, args.result);
      const resultJson = JSON.stringify(acknowledged);
      this.storage.sql.exec(
        `UPDATE ghostbuild_tool_operations
         SET result_json = ?, updated_at = ?
         WHERE tool_call_id = ? AND status = 'completed'`,
        resultJson,
        args.now ?? Date.now(),
        args.toolCallId,
      );
      return acknowledged;
    });
  }

  has(toolCallId: string): boolean {
    return this.read(toolCallId) !== undefined;
  }

  isRunning(toolCallId: string): boolean {
    return this.read(toolCallId)?.status === 'running';
  }

  /**
   * A row left running by an instance that died, with no cancellation recorded against it. This is
   * the only interruption whose external effect may still be observable, so it is reported apart
   * from the rows whose outcome the journal already knows.
   */
  interrupted(toolCallId: string): { toolName: string } | null {
    const row = this.read(toolCallId);
    return row?.status === 'running' && row.error === null ? { toolName: row.tool_name } : null;
  }

  toolName(toolCallId: string): string {
    return this.require(toolCallId).tool_name;
  }

  mutationReceipt(toolCallId: string): MutationReceipt | null {
    const existing = this.require(toolCallId);
    if (existing.status !== 'completed' || existing.result_json === null) {
      return null;
    }
    const result: unknown = JSON.parse(existing.result_json);
    return isMutationReceipt(result) ? result : null;
  }

  registerPending(args: { backend: string; toolCallId: string; result: unknown; now?: number }): void {
    const resultJson = encodeResult({
      kind: 'workspace-sync-pending',
      backend: args.backend,
      result: args.result,
    } satisfies PendingCommandEnvelope);
    this.storage.transactionSync(() => {
      const operation = this.require(args.toolCallId);
      if (operation.status !== 'running') {
        throw new Error('Only a running workspace tool operation can wait for synchronization.');
      }
      const existing = this.pending().find((pending) => pending.backend === args.backend);
      if (existing && (existing.toolCallId !== args.toolCallId || operation.result_json !== resultJson)) {
        throw new Error('A Computer backend already has a different pending tool operation.');
      }
      this.storage.sql.exec(
        `UPDATE ghostbuild_tool_operations
         SET result_json = ?, updated_at = ?
         WHERE tool_call_id = ? AND status = 'running'`,
        resultJson,
        args.now ?? Date.now(),
        args.toolCallId,
      );
    });
  }

  pending(): PendingToolOperation[] {
    return [
      ...this.storage.sql.exec<PendingToolOperationRow>(
        `SELECT tool_call_id, result_json
       FROM ghostbuild_tool_operations
       WHERE status = 'running' AND result_json IS NOT NULL
       ORDER BY tool_call_id`,
      ),
    ].map((row) => {
      const envelope = pendingEnvelope(row.result_json);
      if (!envelope) {
        throw new Error('A pending workspace tool operation has invalid recovery state.');
      }
      return { backend: envelope.backend, toolCallId: row.tool_call_id, result: envelope.result };
    });
  }

  completePending(backend: string, overrideResult?: unknown): boolean {
    return this.storage.transactionSync(() => {
      const pending = this.pending().find((operation) => operation.backend === backend);
      if (!pending) {
        return false;
      }
      const resultJson = encodeResult(overrideResult === undefined ? pending.result : overrideResult);
      this.storage.sql.exec(
        `UPDATE ghostbuild_tool_operations
         SET status = 'completed', result_json = ?, error = NULL, updated_at = ?
         WHERE tool_call_id = ? AND status = 'running'`,
        resultJson,
        Date.now(),
        pending.toolCallId,
      );
      this.pruneTerminalOperations();
      return true;
    });
  }

  fail(args: { toolCallId: string; error: string; now?: number }): void {
    this.storage.transactionSync(() => {
      const existing = this.require(args.toolCallId);
      if (existing.status !== 'running' || existing.error !== null) {
        return;
      }
      this.storage.sql.exec(
        `UPDATE ghostbuild_tool_operations
         SET status = 'failed', result_json = NULL, error = ?, updated_at = ?
         WHERE tool_call_id = ? AND status = 'running'`,
        args.error.slice(-MAX_TOOL_ERROR_LENGTH),
        args.now ?? Date.now(),
        args.toolCallId,
      );
      this.pruneTerminalOperations();
    });
  }

  cancel(args: { toolCallId: string; error: string; active: boolean; now?: number }): ToolOperationCancellationResult {
    if (args.active) {
      this.storage.transactionSync(() => {
        const existing = this.read(args.toolCallId);
        if (!existing) {
          this.recordCancellation(args);
        } else if (existing.status === 'running' && existing.error === null) {
          this.storage.sql.exec(
            `UPDATE ghostbuild_tool_operations
             SET error = ?, updated_at = ?
             WHERE tool_call_id = ? AND status = 'running' AND error IS NULL`,
            args.error.slice(-MAX_TOOL_ERROR_LENGTH),
            args.now ?? Date.now(),
            args.toolCallId,
          );
        }
      });
      return { status: 'active' };
    }
    const existing = this.read(args.toolCallId);
    if (!existing) {
      this.recordCancellation(args);
      return { status: 'settled' };
    }
    if (existing.status === 'running' && existing.error !== null) {
      this.storage.sql.exec(
        `UPDATE ghostbuild_tool_operations
         SET status = 'failed', result_json = NULL, updated_at = ?
         WHERE tool_call_id = ? AND status = 'running'`,
        args.now ?? Date.now(),
        args.toolCallId,
      );
      this.pruneTerminalOperations();
      return { status: 'settled' };
    }
    this.fail(args);
    return { status: 'settled' };
  }

  assertRunning(toolCallId: string): void {
    const existing = this.require(toolCallId);
    if (existing.status === 'running' && existing.error === null) {
      return;
    }
    if (existing.error !== null) {
      throw new Error(existing.error);
    }
    if (existing.status === 'failed') {
      throw new Error('The workspace tool operation failed.');
    }
    throw new Error('The workspace tool operation already completed.');
  }

  private recordCancellation(args: { toolCallId: string; error: string; now?: number }): void {
    this.storage.sql.exec(
      `INSERT INTO ghostbuild_tool_cancellations (tool_call_id, error, cancelled_at)
       VALUES (?, ?, ?)
       ON CONFLICT(tool_call_id) DO NOTHING`,
      args.toolCallId,
      args.error.slice(-MAX_TOOL_ERROR_LENGTH),
      args.now ?? Date.now(),
    );
    this.storage.sql.exec(
      `DELETE FROM ghostbuild_tool_cancellations
       WHERE tool_call_id IN (
         SELECT tool_call_id
         FROM ghostbuild_tool_cancellations
         ORDER BY cancelled_at DESC, tool_call_id DESC
         LIMIT -1 OFFSET ?
       )`,
      MAX_PERSISTED_TOOL_CANCELLATIONS,
    );
  }

  private pruneTerminalOperations(): void {
    this.storage.sql.exec(
      `DELETE FROM ghostbuild_tool_operations
       WHERE tool_call_id IN (
         SELECT tool_call_id
         FROM ghostbuild_tool_operations
         WHERE status != 'running'
         ORDER BY updated_at DESC, tool_call_id DESC
         LIMIT -1 OFFSET ?
       )`,
      MAX_PERSISTED_TOOL_OPERATIONS,
    );
  }

  private cancellation(toolCallId: string): { error: string } | undefined {
    return first(
      this.storage.sql.exec<{ error: string }>(
        `SELECT error FROM ghostbuild_tool_cancellations WHERE tool_call_id = ?`,
        toolCallId,
      ),
    );
  }

  private require(toolCallId: string): ToolOperationRow {
    const row = this.read(toolCallId);
    if (!row) {
      throw new Error('The workspace tool operation was not started.');
    }
    return row;
  }

  private read(toolCallId: string): ToolOperationRow | undefined {
    return first(
      this.storage.sql.exec<ToolOperationRow>(
        `SELECT tool_name, args_sha256, status, result_json, error
         FROM ghostbuild_tool_operations
         WHERE tool_call_id = ?`,
        toolCallId,
      ),
    );
  }
}

function assertSameInvocation(row: ToolOperationRow, invocation: { toolName: string; argsSha256: string }): void {
  if (row.tool_name !== invocation.toolName || row.args_sha256 !== invocation.argsSha256) {
    throw new Error('A workspace tool-call identifier was reused with different arguments.');
  }
}

function startResult(row: ToolOperationRow): ToolOperationStartResult {
  if (row.status === 'running' && row.error !== null) {
    return { status: 'indeterminate', error: row.error };
  }
  if (row.status === 'completed' && row.result_json !== null) {
    return { status: 'completed', result: JSON.parse(row.result_json) };
  }
  if (row.status === 'failed') {
    return { status: 'failed', error: row.error ?? 'The workspace tool operation failed.' };
  }
  return {
    status: 'indeterminate',
    error: 'The workspace tool operation was interrupted after it started and will not be repeated automatically.',
  };
}

function pendingEnvelope(resultJson: string): PendingCommandEnvelope | null {
  const value: unknown = JSON.parse(resultJson);
  return isPendingCommandEnvelope(value) ? value : null;
}

function isPendingCommandEnvelope(value: unknown): value is PendingCommandEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'workspace-sync-pending' &&
    'backend' in value &&
    typeof value.backend === 'string' &&
    'result' in value
  );
}

function encodeResult(result: unknown): string {
  const resultJson = JSON.stringify(result);
  if (resultJson === undefined || new TextEncoder().encode(resultJson).byteLength > MAX_TOOL_RESULT_BYTES) {
    throw new Error('The workspace tool result exceeded its durable result limit.');
  }
  return resultJson;
}
