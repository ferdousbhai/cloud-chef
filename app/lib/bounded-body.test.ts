import { describe, expect, it } from 'vitest';
import { PayloadTooLargeError, readBodyBytesWithLimit, readJsonBodyWithLimit } from './bounded-body';

describe('readBodyBytesWithLimit', () => {
  it('rejects an oversized declared body from its headers', async () => {
    const request = new Request('https://cloudchef.build/upload', {
      method: 'POST',
      headers: { 'Content-Length': '10' },
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);

    await expect(readBodyBytesWithLimit(request, 5, 'Upload')).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it('stops a chunked body when the streamed bytes cross the ceiling', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        },
      }),
    );

    await expect(readBodyBytesWithLimit(response, 3, 'Download')).rejects.toBeInstanceOf(PayloadTooLargeError);
  });
});

describe('readJsonBodyWithLimit', () => {
  it('rejects chunked JSON when streamed bytes cross the ceiling', async () => {
    const request = new Request('https://cloudchef.build/api/data', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"value":"'));
          controller.enqueue(new TextEncoder().encode('x'.repeat(32)));
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);

    await expect(readJsonBodyWithLimit(request, 32, 'JSON request')).rejects.toBeInstanceOf(PayloadTooLargeError);
  });
});
