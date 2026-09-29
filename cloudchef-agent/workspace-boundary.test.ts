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
    'cf dev',
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

  it.each(['cf auth login', 'cf --profile work auth create', 'cd /home/project && cf auth list'])(
    'points the credential command %j at cloudflare_request',
    (command) => {
      expect(rejectedWorkspaceCommand(command)).toMatch(/cloudflare_request/);
    },
  );

  it.each(['cf cli search "list d1 databases"', 'cf schema d1 list', 'cf d1 list --dry-run'])(
    'allows the credential-free cf command %j',
    (command) => {
      expect(rejectedWorkspaceCommand(command)).toBeNull();
    },
  );

  it.each([
    'rm -rf .wrangler',
    'rm -rf /home/project/.wrangler/state',
    'mv .wrangler /tmp/backup',
    'workerd --version',
    'pnpm build; rm -r .wrangler',
    'rm -rf .cloudflare/output',
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
  const completeProject = JSON.stringify(
    {
      name: 'cloudchef-cloudflare-app',
      entrypoint: 'src/plain-server.ts',
      d1: { name: 'cloudchef-cloudflare-app', id: '00000000-0000-0000-0000-000000000000' },
      kv: { id: '00000000000000000000000000000000' },
      r2: { name: 'cloudchef-cloudflare-app-storage' },
    },
    null,
    2,
  );

  it('allows a cloudflare.project.json write that keeps every required resource', () => {
    expect(rejectedWorkspaceFileMutation('/home/project/cloudflare.project.json', completeProject)).toBeNull();
  });

  it.each(['d1', 'r2', 'kv'])('rejects a cloudflare.project.json write that drops the %s resource', (resource) => {
    const project = JSON.parse(completeProject);
    delete project[resource];
    expect(rejectedWorkspaceFileMutation('/home/project/cloudflare.project.json', JSON.stringify(project))).toMatch(
      /required d1 \(DB\)/,
    );
  });

  it.each([
    '/home/project/./cloudflare.project.json',
    '/home/project//cloudflare.project.json',
    '/home/project/src/../cloudflare.project.json',
    '/home/project\\cloudflare.project.json',
    'cloudflare.project.json',
    './cloudflare.project.json',
  ])('rejects a resource-dropping write addressed as %s', (path) => {
    // Every layer below this one canonicalizes, so a non-canonical spelling still lands on the
    // real config.
    expect(rejectedWorkspaceFileMutation(path, '{ "name": "app" }')).toMatch(/required d1 \(DB\)/);
  });

  it('ignores files other than the project Cloudflare configuration', () => {
    expect(rejectedWorkspaceFileMutation('/home/project/src/index.ts', 'export {};')).toBeNull();
    expect(rejectedWorkspaceFileMutation('/home/project/docs/cloudflare.project.json.md', '{}')).toBeNull();
  });
});
