import { describe, expect, it } from 'vitest';
import { rejectedWorkspaceCommand, rejectedWorkspaceFileMutation } from './workspace-boundary.js';

describe('rejectedWorkspaceCommand', () => {
  it.each([
    'pnpm dev',
    'pnpm run dev',
    'pnpm run preview',
    'npm run start',
    'yarn watch',
    'pnpm run test:watch',
    'pnpm exec vite preview',
    'pnpm exec vite',
    'npx vite dev',
    'npx serve dist',
    'vite',
    'vite preview --port 4173',
    'wrangler dev',
    'pnpm exec wrangler dev --local',
    'wrangler tail',
    'next dev',
    'nodemon src/server.ts',
    'http-server dist',
    'tsc --watch',
    'tsc -w',
    'node --watch src/server.ts',
    'tail -f /tmp/server.log',
    'nohup node server.js',
    'node server.js &',
    'cd /home/project && pnpm run dev',
    'pnpm build && pnpm preview',
    'PORT=3000 pnpm dev',
    'timeout 30 vite preview',
  ])('rejects the long-running server command %j', (command) => {
    expect(rejectedWorkspaceCommand(command)).toMatch(/long-running servers/);
  });

  it.each(['kill -9 1234', 'pkill -f workerd', 'killall node', 'fuser -k 8787/tcp', 'cd /home/project && kill 42'])(
    'rejects the process-control command %j',
    (command) => {
      expect(rejectedWorkspaceCommand(command)).toMatch(/process management/i);
    },
  );

  it.each([
    'rm -rf .wrangler',
    'rm -rf /home/project/.wrangler/state',
    'mv .wrangler /tmp/backup',
    'workerd --version',
    'pnpm build; rm -r .wrangler',
    'computerd restart',
  ])('rejects the platform-state command %j', (command) => {
    expect(rejectedWorkspaceCommand(command)).toMatch(/platform runtime state/i);
  });

  it.each([
    'pnpm run validate',
    'cd /home/project && pnpm run validate 2>&1',
    'pnpm run build',
    'pnpm run typecheck && pnpm run lint',
    'pnpm test',
    'pnpm add zod',
    'pnpm install --lockfile-only',
    'vite build',
    'pnpm exec vite build',
    'pnpm exec wrangler deploy --dry-run',
    'node scripts/migrate.js',
    'ls -la src',
    'git status',
    'rm -rf dist',
    'tail -n 50 build.log',
    'grep -rn binding wrangler.jsonc',
    'echo "start the dev server later"',
  ])('allows the finite command %j', (command) => {
    expect(rejectedWorkspaceCommand(command)).toBeNull();
  });
});

describe('rejectedWorkspaceFileMutation', () => {
  const completeConfig = `{
    // Cloudflare resources
    "d1_databases": [{ "binding": "DB" }],
    "r2_buckets": [{ "binding": "APP_STORAGE" }],
    "kv_namespaces": [{ "binding": "APP_CACHE" }],
  }`;

  it('allows a wrangler.jsonc write that keeps every required binding', () => {
    expect(rejectedWorkspaceFileMutation('/home/project/wrangler.jsonc', completeConfig)).toBeNull();
  });

  it.each(['DB', 'APP_STORAGE', 'APP_CACHE'])('rejects a wrangler.jsonc write that drops the %s binding', (binding) => {
    const content = completeConfig.replace(`"binding": "${binding}"`, '"binding": "OTHER"');
    expect(rejectedWorkspaceFileMutation('/home/project/wrangler.jsonc', content)).toMatch(/required DB, APP_STORAGE/);
  });

  it('rejects replacing wrangler.jsonc with a minimal config', () => {
    expect(rejectedWorkspaceFileMutation('/home/project/wrangler.jsonc', '{ "name": "app" }')).toMatch(
      /required DB, APP_STORAGE/,
    );
  });

  it.each([
    '/home/project/./wrangler.jsonc',
    '/home/project//wrangler.jsonc',
    '/home/project/src/../wrangler.jsonc',
    '/home/project\\wrangler.jsonc',
    'wrangler.jsonc',
    './wrangler.jsonc',
  ])('rejects a binding-dropping write addressed as %s', (path) => {
    // Every layer below this one canonicalizes, so a non-canonical spelling still lands on the
    // real config.
    expect(rejectedWorkspaceFileMutation(path, '{ "name": "app" }')).toMatch(/required DB, APP_STORAGE/);
  });

  it('ignores files other than the project wrangler config', () => {
    expect(rejectedWorkspaceFileMutation('/home/project/src/index.ts', 'export {};')).toBeNull();
    expect(rejectedWorkspaceFileMutation('/home/project/docs/wrangler.jsonc.md', '{}')).toBeNull();
  });
});
