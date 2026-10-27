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

  it('reads only tool parts as tool calls', () => {
    expect(getToolInvocation({ type: 'text', text: 'Done.' })).toBeNull();
    expect(getToolInvocation({ type: 'data-tool-progress', data: {} })).toBeNull();
  });

  it('reads a call the agent stored typed by its tool, as the Agents SDK saves every call', () => {
    // What the agent's saved transcript holds for a call streamed as dynamic: the browser's stream assembly
    // makes it `dynamic-tool`, but the saved message, which replaces it once the turn ends, does not.
    const stored = getToolInvocation({
      type: 'tool-cloudflare_request',
      toolName: 'cloudflare_request',
      toolCallId: 'cf-1',
      state: 'output-available',
      input: { method: 'PUT', url: 'https://api.cloudflare.com/client/v4/accounts/a/workers/domains' },
      output: { kind: 'cloudflare_request_proposal' },
    });
    expect(stored).toMatchObject({ type: 'dynamic-tool', toolName: 'cloudflare_request', toolCallId: 'cf-1' });
    expect(stored?.state).toBe('output-available');
    // A static part may leave its name to its type.
    expect(getToolInvocation({ type: 'tool-exec', toolCallId: 'exec-3', state: 'input-available' })?.toolName).toBe(
      'exec',
    );
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
