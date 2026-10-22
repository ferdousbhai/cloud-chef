import { describe, expect, it } from 'vitest';
import { getToolInvocation, isToolInvocationInProgress } from './ai-compat.js';

describe('chat message helpers', () => {
  it('preserves a native error tool state', () => {
    expect(
      getToolInvocation({
        type: 'dynamic-tool',
        toolName: 'read',
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
  });

  it('reads only dynamic tool parts as tool calls', () => {
    expect(getToolInvocation({ type: 'text', text: 'Done.' })).toBeNull();
    expect(getToolInvocation({ type: 'data-tool-progress', data: {} })).toBeNull();
  });

  it('reads a state it does not know as ended in error, and a missing one as streaming input', () => {
    const denied = getToolInvocation({
      type: 'dynamic-tool',
      toolName: 'exec',
      toolCallId: 'exec-1',
      state: 'output-denied',
    });
    expect(denied?.state).toBe('output-error');
    expect(denied && isToolInvocationInProgress(denied)).toBe(false);
    const streaming = getToolInvocation({ type: 'dynamic-tool', toolName: 'exec', toolCallId: 'exec-2' });
    expect(streaming?.state).toBe('input-streaming');
    expect(streaming && isToolInvocationInProgress(streaming)).toBe(true);
  });
});
