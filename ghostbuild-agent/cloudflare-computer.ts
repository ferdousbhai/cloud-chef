import type { CreateAIToolsOptions } from '@cloudflare/computer/tools';

// Computer 0.2.1 declares itself preview-only. Keep the exact pin, the local
// dist patch, and the durable workspace surfaces reviewed together.
export const CLOUDFLARE_COMPUTER_VERSION = '0.2.1';
export const GENERATED_PROJECT_PNPM_VERSION = '11.14.0';

export const COMPUTER_SHELL_BACKEND_IDS = ['container-shell'] as const;
export type ComputerShellBackend = (typeof COMPUTER_SHELL_BACKEND_IDS)[number];

export const COMPUTER_DEFAULT_SHELL_BACKEND = 'container-shell' satisfies ComputerShellBackend;

export const COMPUTER_SYNC_PENDING_ERROR_CODE = 'workspace_sync_pending';
export const COMPUTER_SYNC_EXHAUSTED_ERROR_CODE = 'workspace_sync_exhausted';
export const WORKSPACE_OPERATION_CONFLICT_ERROR_CODE = 'workspace_operation_conflict';

export type WorkspaceOperationConflict = { activeKind: string; retryAfterMs: number };

const WORKSPACE_OPERATION_CONFLICT_PATTERN = new RegExp(
  `^\\[${WORKSPACE_OPERATION_CONFLICT_ERROR_CODE}\\] (.+) is running; retry after (\\d+)ms\\.$`,
);

/** Stateful ProjectWorkspace operations reject instead of waiting, so the retry budget travels in the message. */
export function workspaceOperationConflictMessage(conflict: WorkspaceOperationConflict): string {
  return `[${WORKSPACE_OPERATION_CONFLICT_ERROR_CODE}] ${conflict.activeKind} is running; retry after ${conflict.retryAfterMs}ms.`;
}

export function workspaceOperationConflict(error: unknown): WorkspaceOperationConflict | null {
  const match = WORKSPACE_OPERATION_CONFLICT_PATTERN.exec(error instanceof Error ? error.message : '');
  return match ? { activeKind: match[1]!, retryAfterMs: Number(match[2]) } : null;
}

export type ComputerSyncUnconfirmedCode =
  typeof COMPUTER_SYNC_PENDING_ERROR_CODE | typeof COMPUTER_SYNC_EXHAUSTED_ERROR_CODE;

export type ComputerSyncUnconfirmedToolResult = {
  kind: 'workspace-sync-unconfirmed';
  version: 1;
  acknowledgement: 'pending';
  status: 'pending' | 'exhausted';
  code: ComputerSyncUnconfirmedCode;
  error: string;
};

/** Workers RPC may preserve only an exception message, so the stable code is embedded in both fields. */
export function isComputerSyncUnconfirmedError(error: unknown): boolean {
  return syncUnconfirmedCode(error) !== null;
}

export function computerSyncUnconfirmedToolResult(value: unknown): ComputerSyncUnconfirmedToolResult | null {
  const code = syncUnconfirmedCode(value);
  if (!code) {
    return null;
  }
  const message = syncUnconfirmedMessage(value, code);
  return {
    kind: 'workspace-sync-unconfirmed',
    version: 1,
    acknowledgement: 'pending',
    status: code === COMPUTER_SYNC_EXHAUSTED_ERROR_CODE ? 'exhausted' : 'pending',
    code,
    error: message.slice(-4_000),
  };
}

export function computerSyncUnconfirmedError(value: unknown): Error | null {
  const result = computerSyncUnconfirmedToolResult(value);
  if (!result) {
    return null;
  }
  return Object.assign(new Error(result.error), { name: 'WorkspaceSyncPendingError', code: result.code });
}

/** The message a rejection carries, whether it stayed an Error or was flattened to a plain object by RPC. */
function carriedMessage(value: unknown): string | null {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'object' && value !== null) {
    if ('error' in value && typeof value.error === 'string') {
      return value.error;
    }
    if ('message' in value && typeof value.message === 'string') {
      return value.message;
    }
  }
  return null;
}

function carriedCode(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'code' in value ? value.code : undefined;
}

function syncUnconfirmedCode(value: unknown): ComputerSyncUnconfirmedCode | null {
  const code = carriedCode(value);
  const message = carriedMessage(value) ?? (typeof value === 'string' ? value : '');
  if (code === COMPUTER_SYNC_PENDING_ERROR_CODE || message.startsWith(`[${COMPUTER_SYNC_PENDING_ERROR_CODE}]`)) {
    return COMPUTER_SYNC_PENDING_ERROR_CODE;
  }
  if (code === COMPUTER_SYNC_EXHAUSTED_ERROR_CODE || message.startsWith(`[${COMPUTER_SYNC_EXHAUSTED_ERROR_CODE}]`)) {
    return COMPUTER_SYNC_EXHAUSTED_ERROR_CODE;
  }
  return null;
}

function syncUnconfirmedMessage(value: unknown, code: ComputerSyncUnconfirmedCode): string {
  return carriedMessage(value) ?? `[${code}] Computer synchronization is not yet durably acknowledged.`;
}

export const COMPUTER_EXEC_APPLICATION_POLICY =
  'Run finite commands only; do not start development, preview, watch, or other long-running servers. Ghostbuild manages previews after validation. Dependency changes support pnpm add <packages> and pnpm install --lockfile-only.';

export const COMPUTER_TOOL_LIMITS = {
  readMaxBytes: 1024 * 1024,
  readMaxLines: 10_000,
  // Not a product choice: 2 MiB is the Durable Object SQLite hard limit for a single stored value,
  // and a mutation that exceeds it cannot be persisted at all. Raising this would fail at write.
  mutationMaxBytes: 2 * 1024 * 1024,
  mutationReceiptMaxBytes: 64 * 1024,
  mutationDiffSummaryMaxBytes: 16 * 1024,
  mutationReceiptMaxPaths: 100,
  execMaxBytesPerStream: 256 * 1024,
} as const;

export const COMPUTER_SHELL_TOOL_OPTIONS = {
  defaultBackend: COMPUTER_DEFAULT_SHELL_BACKEND,
  backends: {
    [COMPUTER_DEFAULT_SHELL_BACKEND]: {
      description:
        'Cloudflare Container with full Linux userland, public network access, Node.js, pnpm, git, Wrangler, and build tools.',
    },
  },
} as const satisfies {
  defaultBackend: ComputerShellBackend;
  backends: Record<ComputerShellBackend, { description: string }>;
};

// Keep every optional createAITools capability explicit. In particular,
// publishing must not appear if the structural workspace later gains assets.
export const COMPUTER_AI_TOOL_OPTIONS = {
  assets: false,
  read: {
    maxBytes: COMPUTER_TOOL_LIMITS.readMaxBytes,
    maxLines: COMPUTER_TOOL_LIMITS.readMaxLines,
  },
  write: { maxBytes: COMPUTER_TOOL_LIMITS.mutationMaxBytes },
  edit: { maxBytes: COMPUTER_TOOL_LIMITS.mutationMaxBytes },
  shell: {
    ...COMPUTER_SHELL_TOOL_OPTIONS,
    maxBytes: COMPUTER_TOOL_LIMITS.execMaxBytesPerStream,
  },
} as const satisfies Omit<CreateAIToolsOptions, 'workspace'>;
