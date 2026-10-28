import { describe, expect, it, vi } from 'vitest';
import { DURABLE_OBJECT_OVERLOADED_MESSAGE, internalErrorResponse } from './http.server';
import { ConversationLimitError } from './errors';

describe('internalErrorResponse', () => {
  it('does not reflect unexpected backend error messages to callers', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = internalErrorResponse(
      new Error('SECRET_DATABASE_MARKER: no such table cloudflare_credentials'),
      'Unknown data error',
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Unknown data error' });
    consoleError.mockRestore();
  });

  it('returns a conflict when a project reaches the subchat ceiling', async () => {
    const response = internalErrorResponse(new ConversationLimitError(), 'Unknown data error');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'This project has reached the maximum number of subchats.' });
  });

  it('tells the caller a Durable Object overload is worth retrying, without exposing provider details', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const overloaded = Object.assign(new Error('SECRET_PROVIDER_MARKER: queue full'), {
      overloaded: true,
      retryable: true,
    });

    const response = internalErrorResponse(overloaded, 'Unknown data error');
    const body = await response.json();

    expect(response.status).toBe(503);
    // An overloaded object is busy, not broken, so refusing the retry stranded the caller
    // on a condition that clears by itself.
    expect(body).toEqual({ error: DURABLE_OBJECT_OVERLOADED_MESSAGE, retryable: true });
    // The caller learns it is overload rather than the operation's generic fallback, and
    // still learns nothing about the provider.
    expect(JSON.stringify(body)).not.toContain('SECRET_PROVIDER_MARKER');
    expect(JSON.stringify(body)).not.toContain('Unknown data error');
    consoleError.mockRestore();
  });

  it('identifies an unhandled failure in the log without putting it in the response', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = internalErrorResponse(new Error('SECRET_PROVIDER_MARKER: exploded'), 'Unknown data error');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Unknown data error' });
    expect(consoleError.mock.calls.flat().join(' ')).toContain('SECRET_PROVIDER_MARKER: exploded');
    consoleError.mockRestore();
  });
});
