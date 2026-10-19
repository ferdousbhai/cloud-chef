import { describe, expect, it } from 'vitest';
import { providerStopDiagnosticCode } from './provider-stop-error';

/** The shape `logProviderFailure` will accept as a diagnostic code. */
const DIAGNOSTIC_CODE_PATTERN = /^[a-z0-9_:-]{1,64}$/;

describe('providerStopDiagnosticCode', () => {
  it.each([
    ['Stream ended without finish_reason', 'stream_ended_without_finish'],
    ['Provider finish_reason: content_filter', 'provider_finish_content_filter'],
    ['Provider finish_reason: network_error', 'provider_finish_network_error'],
    ['400: {"error":"max_completion_tokens is too large"}', 'http_400'],
    ['429 Too Many Requests', 'http_429'],
    ['403 status code (no body)', 'http_403'],
    ['Workers AI (500): upstream unavailable', 'http_500'],
    ["Requested token count exceeds the model's maximum context length of 131072 tokens", 'context_overflow'],
    ['prompt is too long: 213462 tokens > 200000 maximum', 'context_overflow'],
    ['The model request failed.', 'provider_error_other'],
    ['', 'provider_error_other'],
  ])('classifies %j as %s', (message, expected) => {
    const code = providerStopDiagnosticCode(message);

    expect(code).toBe(expected);
    expect(code).toMatch(DIAGNOSTIC_CODE_PATTERN);
  });

  it('prefers the context cause over the status line a provider wraps it in', () => {
    expect(
      providerStopDiagnosticCode("400: Input length (265330) exceeds model's maximum context length (262144)."),
    ).toBe('context_overflow');
  });
});
