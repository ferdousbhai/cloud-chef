import { COMPUTER_TOOL_LIMITS } from '../../cloudchef-agent/cloudflare-computer';

export type MutationReceiptFile = {
  path: string;
  revision: number;
  size: number;
  sha256: string | null;
  deleted: boolean;
};

export type MutationReceipt = {
  kind: 'workspace-mutation-receipt';
  version: 1;
  committed: true;
  acknowledgement: 'pending' | 'complete';
  tool: 'write' | 'edit';
  files: MutationReceiptFile[];
  changedRanges: Array<{ path: string; startLine: number; endLine: number }>;
  diffSummary: string | null;
  truncated: {
    result: boolean;
    diff: boolean;
    paths: boolean;
    omittedBytes: number;
  };
};

export type MutationReceiptFileInput = MutationReceiptFile & {
  changedRange?: { startLine: number; endLine: number };
};

export function createCommittedMutationReceipt(args: {
  tool: 'write' | 'edit';
  files: MutationReceiptFileInput[];
}): MutationReceipt {
  const pathsTruncated = args.files.length > COMPUTER_TOOL_LIMITS.mutationReceiptMaxPaths;
  const boundedFiles = args.files.slice(0, COMPUTER_TOOL_LIMITS.mutationReceiptMaxPaths);
  return {
    kind: 'workspace-mutation-receipt',
    version: 1,
    committed: true,
    acknowledgement: 'pending',
    tool: args.tool,
    files: boundedFiles.map(({ changedRange: _changedRange, ...file }) => file),
    changedRanges: boundedFiles.map((file) => ({
      path: file.path,
      startLine: file.changedRange?.startLine ?? 1,
      endLine: file.changedRange?.endLine ?? 1,
    })),
    diffSummary: null,
    truncated: { result: false, diff: false, paths: pathsTruncated, omittedBytes: 0 },
  };
}

export function acknowledgeMutationReceipt(receipt: MutationReceipt, result: unknown): MutationReceipt {
  const raw = recordOrNull(result);
  const diff = typeof raw?.diff === 'string' ? raw.diff : typeof raw?.patch === 'string' ? raw.patch : '';
  const boundedDiff = truncateUtf8(diff, COMPUTER_TOOL_LIMITS.mutationDiffSummaryMaxBytes);
  const hasDisplayRange =
    diff.length > 0 || (Number.isSafeInteger(raw?.firstChangedLine) && Number(raw?.firstChangedLine) > 0);
  const changedRange = changedLineRange(diff, raw?.firstChangedLine);
  const changedRanges = hasDisplayRange
    ? receipt.files.map((file) => ({
        path: file.path,
        startLine: changedRange.startLine,
        endLine: changedRange.endLine,
      }))
    : receipt.changedRanges;
  const originalBytes = byteLength(JSON.stringify(result) ?? '');
  let acknowledged: MutationReceipt = {
    ...receipt,
    acknowledgement: 'complete',
    changedRanges,
    diffSummary: boundedDiff.value || null,
    truncated: {
      ...receipt.truncated,
      result: originalBytes > COMPUTER_TOOL_LIMITS.mutationReceiptMaxBytes,
      diff: boundedDiff.truncated,
      omittedBytes: Math.max(0, originalBytes - COMPUTER_TOOL_LIMITS.mutationReceiptMaxBytes),
    },
  };
  if (byteLength(JSON.stringify(acknowledged)) > COMPUTER_TOOL_LIMITS.mutationReceiptMaxBytes) {
    acknowledged = {
      ...acknowledged,
      diffSummary: null,
      truncated: { ...acknowledged.truncated, result: true, diff: true },
    };
  }
  return acknowledged;
}

export function isMutationReceipt(value: unknown): value is MutationReceipt {
  const input = recordOrNull(value);
  return (
    input?.kind === 'workspace-mutation-receipt' &&
    input.version === 1 &&
    input.committed === true &&
    (input.tool === 'write' || input.tool === 'edit') &&
    Array.isArray(input.files)
  );
}

function changedLineRange(diff: string, firstChangedLine: unknown): { startLine: number; endLine: number } {
  const fallback =
    Number.isSafeInteger(firstChangedLine) && Number(firstChangedLine) > 0 ? Number(firstChangedLine) : 1;
  let startLine = Number.MAX_SAFE_INTEGER;
  let endLine = 0;
  for (const match of diff.matchAll(/^\+\s*(\d+)\s/gm)) {
    const line = Number(match[1]);
    startLine = Math.min(startLine, line);
    endLine = Math.max(endLine, line);
  }
  return endLine > 0 ? { startLine, endLine } : { startLine: fallback, endLine: fallback };
}

type TruncatedText = { value: string; truncated: boolean };

function truncateUtf8(value: string, maxBytes: number): TruncatedText {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) {
    return { value, truncated: false };
  }
  return {
    value: new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/\uFFFD$/, ''),
    truncated: true,
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
