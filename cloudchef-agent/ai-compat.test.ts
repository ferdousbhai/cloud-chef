import { describe, expect, it } from 'vitest';
import { getToolInvocation } from './ai-compat.js';

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
});
