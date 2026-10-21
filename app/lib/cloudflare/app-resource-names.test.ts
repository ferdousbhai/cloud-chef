import { describe, expect, it } from 'vitest';
import { appResourceIdentity, appResourceName } from './app-resource-names';

const IDENTITY = 'd6738251-57e1-4d83-9589-1b6c6d982417';

describe('app resource naming', () => {
  it('composes every logical binding onto the app identity', () => {
    expect(appResourceName(IDENTITY, 'app')).toBe(`cloudchef-${IDENTITY}`);
    expect(appResourceName(IDENTITY, 'app_preview')).toBe(`d6738251-cloudchef-${IDENTITY}-preview`);
    expect(appResourceName(IDENTITY, 'DB')).toBe(`cloudchef-${IDENTITY}`);
    expect(appResourceName(IDENTITY, 'DB_PREVIEW')).toBe(`cloudchef-${IDENTITY}-preview`);
    expect(appResourceName(IDENTITY, 'AGENT_SECURITY_DB')).toBe(`cloudchef-${IDENTITY}-agent-security`);
    expect(appResourceName(IDENTITY, 'AGENT_SECURITY_DB_PREVIEW')).toBe(`cloudchef-${IDENTITY}-preview-agent`);
    expect(appResourceName(IDENTITY, 'APP_STORAGE')).toBe(`cloudchef-${IDENTITY}-storage`);
    expect(appResourceName(IDENTITY, 'APP_STORAGE_PREVIEW')).toBe(`cloudchef-${IDENTITY}-preview-storage`);
    expect(appResourceName(IDENTITY, 'APP_CACHE')).toBe(`cloudchef-${IDENTITY}-cache`);
    expect(appResourceName(IDENTITY, 'APP_CACHE_PREVIEW')).toBe(`cloudchef-${IDENTITY}-preview-cache`);
  });

  it('gives each project one identity, in the shape deployments named their resources after', async () => {
    const project = 'a'.repeat(64);
    const identity = await appResourceIdentity(project);

    expect(identity).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await expect(appResourceIdentity(project)).resolves.toBe(identity);
    await expect(appResourceIdentity('b'.repeat(64))).resolves.not.toBe(identity);
    // Its longest resource name still fits Cloudflare's 63 characters for a Worker and an R2 bucket.
    expect(appResourceName(identity, 'AGENT_SECURITY_DB').length).toBeLessThanOrEqual(63);
    expect(appResourceName(identity, 'APP_STORAGE_PREVIEW').length).toBeLessThanOrEqual(63);
    expect(appResourceName(identity, 'app_preview').length).toBeLessThanOrEqual(63);
  });

  it('starts only the preview Worker with the eight hex digits a project lets cloudchef.build frame', async () => {
    const identity = await appResourceIdentity('a'.repeat(64));
    const leadsWithHex = (name: string) => /^[0-9a-f]{8}-/.test(name);

    expect(leadsWithHex(appResourceName(identity, 'app_preview'))).toBe(true);
    // Production's name starts `cloudchef-`, whose "l" is not hex, whatever the identity.
    expect(appResourceName(identity, 'app')).toMatch(/^cloudchef-/);
    expect(leadsWithHex(appResourceName(identity, 'app'))).toBe(false);
    expect(leadsWithHex(appResourceName('ffffffff', 'app'))).toBe(false);
  });
});
