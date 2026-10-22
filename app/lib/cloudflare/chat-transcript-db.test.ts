import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_HISTORY_FORMAT_VERSION } from 'cloudchef-agent/transcript';
import { parseTranscriptResponse, projectMessagesRequestError } from './chat-transcript-db';

const checkpoint = {
  agentName: 'agent-1',
  subchatIndex: 0,
  revision: 1,
  digest: 'a'.repeat(64),
  messageCount: 1,
};

describe('parseTranscriptResponse', () => {
  const ready = {
    status: 'ready',
    version: TRANSCRIPT_HISTORY_FORMAT_VERSION,
    initialId: 'chat-1',
    transcript: { agentName: 'agent-1', subchatIndex: 0 },
    checkpoint,
    messages: [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Build' }] }],
  };

  it('accepts a missing chat, or the current versioned transcript envelope', () => {
    expect(parseTranscriptResponse({ status: 'missing' })).toEqual({ status: 'missing' });
    expect(parseTranscriptResponse(ready)).toEqual(ready);
    expect(parseTranscriptResponse({ ...ready, checkpoint: null, messages: [] })).toMatchObject({ checkpoint: null });

    expect(() => parseTranscriptResponse([])).toThrow();
    expect(() => parseTranscriptResponse({ ...ready, version: TRANSCRIPT_HISTORY_FORMAT_VERSION - 1 })).toThrow();
    expect(() => parseTranscriptResponse({ ...ready, transcript: { agentName: 'agent-1' } })).toThrow();
    expect(() => parseTranscriptResponse({ ...ready, legacy: true })).toThrow();
  });
});

describe('projectMessagesRequestError', () => {
  it('preserves an explicit non-retryable overload marker', async () => {
    const error = await projectMessagesRequestError(
      Response.json({ error: 'Project storage is busy', retryable: false }, { status: 503 }),
    );

    expect(error).toMatchObject({
      name: 'UserRuntimeRequestError',
      message: 'Failed to fetch project messages (503): Project storage is busy',
      status: 503,
      retryable: false,
    });
  });

  it('ignores malformed retryability metadata and falls back to HTTP status', async () => {
    const error = await projectMessagesRequestError(
      Response.json({ error: 'Unknown failure', retryable: 'false' }, { status: 500 }),
    );

    expect(error.retryable).toBe(true);
  });
});
