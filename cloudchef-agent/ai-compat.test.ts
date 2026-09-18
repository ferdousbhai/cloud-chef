import { describe, expect, it } from 'vitest';
import { getToolInvocation, messageText } from './ai-compat.js';

describe('chat message helpers', () => {
  it('reads message text exclusively from native parts', () => {
    expect(messageText({ parts: [{ type: 'text', text: 'hello' }] })).toBe('hello');
  });

  it('preserves native error and denial tool states', () => {
    expect(
      getToolInvocation({
        type: 'tool-read',
        toolCallId: 'read-1',
        state: 'output-error',
        input: { path: '/home/project/missing.ts' },
        errorText: 'File not found',
      }),
    ).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'read',
      state: 'output-error',
      errorText: 'File not found',
    });
    expect(
      getToolInvocation({
        type: 'dynamic-tool',
        toolName: 'exec',
        toolCallId: 'exec-1',
        state: 'output-denied',
        input: { command: 'dangerous' },
        approval: { id: 'approval-1', approved: false, reason: 'Not approved' },
      }),
    ).toMatchObject({
      state: 'output-denied',
      approval: { approved: false, reason: 'Not approved' },
    });
  });
});
