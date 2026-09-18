import { describe, expect, it } from 'vitest';
import { appResourceName } from './app-resource-names';

const DEPLOYMENT = 'd6738251-57e1-4d83-9589-1b6c6d982417';

describe('app resource naming', () => {
  it('composes every logical binding onto the deployment id', () => {
    expect(appResourceName(DEPLOYMENT, 'app')).toBe(`cloudchef-${DEPLOYMENT}`);
    expect(appResourceName(DEPLOYMENT, 'DB')).toBe(`cloudchef-${DEPLOYMENT}`);
    expect(appResourceName(DEPLOYMENT, 'DB_PREVIEW')).toBe(`cloudchef-${DEPLOYMENT}-preview`);
    expect(appResourceName(DEPLOYMENT, 'AGENT_SECURITY_DB')).toBe(`cloudchef-${DEPLOYMENT}-agent-security`);
    expect(appResourceName(DEPLOYMENT, 'AGENT_SECURITY_DB_PREVIEW')).toBe(`cloudchef-${DEPLOYMENT}-preview-agent`);
    expect(appResourceName(DEPLOYMENT, 'APP_STORAGE')).toBe(`cloudchef-${DEPLOYMENT}-storage`);
    expect(appResourceName(DEPLOYMENT, 'APP_CACHE')).toBe(`cloudchef-${DEPLOYMENT}-cache`);
  });
});
