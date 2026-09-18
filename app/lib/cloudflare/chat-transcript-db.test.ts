import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_HISTORY_FORMAT_VERSION } from 'cloudchef-agent/transcript';
import { parseMessageHistory, projectMessagesRequestError, transcriptIdentityFromHeaders } from './chat-transcript-db';

const checkpoint = {
  agentName: 'agent-1',
  generation: 0,
  subchatIndex: 0,
  revision: 1,
  digest: 'a'.repeat(64),
  messageCount: 1,
};

describe('parseMessageHistory', () => {
  it('accepts only the current versioned transcript envelope', () => {
    expect(
      parseMessageHistory({
        version: TRANSCRIPT_HISTORY_FORMAT_VERSION,
        transcript: checkpoint,
        messages: [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Build' }] }],
      }),
    ).toEqual({
      checkpoint,
      messages: [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Build' }] }],
    });

    expect(() => parseMessageHistory([])).toThrow();
    expect(() =>
      parseMessageHistory({ version: TRANSCRIPT_HISTORY_FORMAT_VERSION - 1, transcript: checkpoint, messages: [] }),
    ).toThrow();
    expect(() =>
      parseMessageHistory({
        version: TRANSCRIPT_HISTORY_FORMAT_VERSION,
        transcript: checkpoint,
        messages: [],
        legacy: true,
      }),
    ).toThrow();
  });
});

describe('transcriptIdentityFromHeaders', () => {
  it('requires complete valid user-runtime transcript identity headers', () => {
    expect(
      transcriptIdentityFromHeaders(
        new Headers({
          'X-CloudChef-Transcript-Agent': 'agent-1',
          'X-CloudChef-Transcript-Generation': '2',
          'X-CloudChef-Transcript-Subchat': '3',
        }),
      ),
    ).toEqual({ agentName: 'agent-1', generation: 2, subchatIndex: 3 });

    expect(() => transcriptIdentityFromHeaders(new Headers())).toThrow('invalid transcript identity headers');
    expect(() =>
      transcriptIdentityFromHeaders(
        new Headers({
          'X-CloudChef-Transcript-Agent': 'agent-1',
          'X-CloudChef-Transcript-Generation': 'invalid',
          'X-CloudChef-Transcript-Subchat': '3',
        }),
      ),
    ).toThrow('invalid transcript identity headers');
    expect(() =>
      transcriptIdentityFromHeaders(
        new Headers({
          'X-CloudChef-Transcript-Agent': 'agent-1',
          'X-CloudChef-Transcript-Generation': '',
          'X-CloudChef-Transcript-Subchat': '3',
        }),
      ),
    ).toThrow('invalid transcript identity headers');
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
