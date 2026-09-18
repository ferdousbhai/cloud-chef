import { describe, expect, test } from 'vitest';
import {
  CLOUDFLARE_AI_FUNDING_REQUIRED_MARKER,
  cloudflareAiFundingRequiredMessage,
  isCloudflareAiFundingError,
  isWorkersAiFreeAllocationError,
} from './workers-paid';

describe('Workers Paid consent boundary', () => {
  test('recognizes free Workers AI allocation exhaustion without treating generic failures as billing prompts', () => {
    expect(isWorkersAiFreeAllocationError(new Error('Free AI allocation of 10,000 neurons exhausted'))).toBe(true);
    expect(isWorkersAiFreeAllocationError({ responseBody: 'Upgrade to Workers Paid to continue' })).toBe(true);
    expect(isWorkersAiFreeAllocationError(new Error('capacity temporarily exceeded'))).toBe(false);
    expect(isWorkersAiFreeAllocationError(new Error('permission denied'))).toBe(false);
  });

  test('recognizes partner-model funding failures without conflating them with Workers Paid', () => {
    const error = {
      responseBody: JSON.stringify({
        errors: [{ code: 2021, message: 'Insufficient balance; add money to your gateway or use BYOK' }],
      }),
    };

    expect(isCloudflareAiFundingError(error)).toBe(true);
    expect(isWorkersAiFreeAllocationError(error)).toBe(false);
    expect(cloudflareAiFundingRequiredMessage()).toContain(CLOUDFLARE_AI_FUNDING_REQUIRED_MARKER);
    expect(cloudflareAiFundingRequiredMessage()).toContain('AI Gateway Unified Billing');
    expect(cloudflareAiFundingRequiredMessage()).toContain('Credits Available');
    expect(cloudflareAiFundingRequiredMessage()).toContain('Top-up credits');
    expect(cloudflareAiFundingRequiredMessage()).toContain('CloudChef did not make a purchase');
  });

  test('recognizes the misleading Workers AI binding wrapper for an unfunded partner model', () => {
    expect(isCloudflareAiFundingError(new Error('2021: Invalid User Credentials'))).toBe(true);
    expect(isCloudflareAiFundingError(new Error('Invalid User Credentials (2021)'))).toBe(true);
  });

  test('does not treat unrelated provider failures as AI Gateway funding failures', () => {
    expect(isCloudflareAiFundingError(new Error('Provider timed out'))).toBe(false);
    expect(isCloudflareAiFundingError(new Error('Invalid User Credentials'))).toBe(false);
  });
});
