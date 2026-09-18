import { describe, expect, it } from 'vitest';
import { COMPUTER_TOOL_LIMITS } from '../../cloudchef-agent/cloudflare-computer';
import { acknowledgeMutationReceipt, createCommittedMutationReceipt } from './mutation-receipt';

describe('bounded Computer mutation receipts', () => {
  it('keeps a near-2 MiB successful edit committed while explicitly truncating its display patch', () => {
    const committed = createCommittedMutationReceipt({
      tool: 'edit',
      files: [
        {
          path: '/home/project/large.ts',
          revision: 42,
          size: COMPUTER_TOOL_LIMITS.mutationMaxBytes - 1,
          sha256: 'a'.repeat(64),
          deleted: false,
        },
      ],
    });
    const result = {
      path: '/home/project/large.ts',
      editsApplied: 1,
      firstChangedLine: 10,
      diff: `+10 changed\n${'x'.repeat(700_000)}`,
      patch: 'y'.repeat(700_000),
    };

    const receipt = acknowledgeMutationReceipt(committed, result);

    expect(receipt).toMatchObject({
      committed: true,
      acknowledgement: 'complete',
      files: [{ revision: 42, sha256: 'a'.repeat(64) }],
      changedRanges: [{ startLine: 10, endLine: 10 }],
      truncated: { result: true, diff: true, omittedBytes: expect.any(Number) },
    });
    expect(new TextEncoder().encode(JSON.stringify(receipt)).byteLength).toBeLessThanOrEqual(
      COMPUTER_TOOL_LIMITS.mutationReceiptMaxBytes,
    );
  });

  it('caps paths using the same centralized Computer limits', () => {
    const receipt = createCommittedMutationReceipt({
      tool: 'write',
      files: Array.from({ length: COMPUTER_TOOL_LIMITS.mutationReceiptMaxPaths + 1 }, (_, index) => ({
        path: `/home/project/${index}.txt`,
        revision: 1,
        size: 1,
        sha256: 'b'.repeat(64),
        deleted: false,
      })),
    });

    expect(receipt.files).toHaveLength(COMPUTER_TOOL_LIMITS.mutationReceiptMaxPaths);
    expect(receipt.truncated.paths).toBe(true);
  });

  it('parses the padded line numbers emitted by Computer for multi-line edits', () => {
    const committed = createCommittedMutationReceipt({
      tool: 'edit',
      files: [{ path: '/home/project/a.ts', revision: 2, size: 100, sha256: 'c'.repeat(64), deleted: false }],
    });

    const receipt = acknowledgeMutationReceipt(committed, {
      diff: ['+  5 first', '+ 10 second', '+100 third'].join('\n'),
    });

    expect(receipt.changedRanges).toEqual([{ path: '/home/project/a.ts', startLine: 5, endLine: 100 }]);
  });
});
