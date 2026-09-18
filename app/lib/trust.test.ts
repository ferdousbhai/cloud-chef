import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('security.txt', () => {
  it('stays valid long enough to renew before RFC 9116 expiry', () => {
    const security = readFileSync('public/.well-known/security.txt', 'utf8');
    const expires = /^Expires: (.+)$/m.exec(security)?.[1];

    expect(security).toContain('Contact: https://github.com/ferdousbhai/cloud-chef/security/advisories/new');
    expect(expires).toBeDefined();
    const remainingDays = (Date.parse(String(expires)) - Date.now()) / 86_400_000;
    expect(Number.isNaN(remainingDays)).toBe(false);
    expect(remainingDays).toBeGreaterThan(30);
  });
});
