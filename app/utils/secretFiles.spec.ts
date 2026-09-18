import { describe, expect, it } from 'vitest';
import { WORK_DIR } from 'cloudchef-agent/constants';
import { assertNotLocalSecretFilePath, isLocalSecretFilePath } from './secretFiles';

describe('local secret file paths', () => {
  it('blocks local env, ecosystem credential, and dev vars files', () => {
    expect(isLocalSecretFilePath('.git')).toBe(true);
    expect(isLocalSecretFilePath(`${WORK_DIR}/.git/config`)).toBe(true);
    expect(isLocalSecretFilePath(`${WORK_DIR}/nested/.git/config`)).toBe(true);
    expect(isLocalSecretFilePath('.env')).toBe(true);
    expect(isLocalSecretFilePath('.env.local')).toBe(true);
    expect(isLocalSecretFilePath('.npmrc')).toBe(true);
    expect(isLocalSecretFilePath(`${WORK_DIR}/nested/.npmrc`)).toBe(true);
    expect(isLocalSecretFilePath(`${WORK_DIR}/.pnpmfile.cjs`)).toBe(true);
    expect(isLocalSecretFilePath(`${WORK_DIR}/nested/.pnpmfile.js`)).toBe(true);
    for (const fileName of ['.netrc', '_netrc', '.git-credentials', '.pypirc', '.yarnrc', '.yarnrc.yml']) {
      expect(isLocalSecretFilePath(fileName)).toBe(true);
      expect(isLocalSecretFilePath(`${WORK_DIR}/nested/${fileName}`)).toBe(true);
    }
    expect(isLocalSecretFilePath(`${WORK_DIR}/.dev.vars`)).toBe(true);
    expect(isLocalSecretFilePath('nested/.dev.vars.production')).toBe(true);
    expect(isLocalSecretFilePath('nested/.envrc')).toBe(true);
    expect(isLocalSecretFilePath(`${WORK_DIR}/nested/.env.production`)).toBe(true);
    expect(isLocalSecretFilePath(`${WORK_DIR}/nested/.dev.vars.production`)).toBe(true);
    expect(isLocalSecretFilePath('nested\\.env.local')).toBe(true);
  });

  it('allows ordinary project files', () => {
    expect(isLocalSecretFilePath('.gitignore')).toBe(false);
    expect(isLocalSecretFilePath('wrangler.jsonc')).toBe(false);
    expect(isLocalSecretFilePath(`${WORK_DIR}/src/npmrc.ts`)).toBe(false);
    expect(isLocalSecretFilePath(`${WORK_DIR}/src/.yarnrc.yml.example`)).toBe(false);
    expect(isLocalSecretFilePath(`${WORK_DIR}/src/git-credentials.md`)).toBe(false);
    expect(isLocalSecretFilePath(`${WORK_DIR}/src/server.ts`)).toBe(false);
  });

  it('throws with Cloudflare binding guidance', () => {
    expect(() => assertNotLocalSecretFilePath('.npmrc')).toThrow(
      /Use a per-Worker secret or, for an exported project, an account-level Cloudflare Secrets Store binding/,
    );
  });

  it('rejects executable dependency hooks with workspace-policy guidance', () => {
    expect(() => assertNotLocalSecretFilePath('nested/.pnpmfile.cjs')).toThrow(
      /Project dependency hook files are disabled.*reviewed pnpm workspace policy/,
    );
  });
});
