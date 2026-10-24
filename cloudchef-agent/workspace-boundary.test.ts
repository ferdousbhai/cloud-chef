import { describe, expect, it } from 'vitest';
import { rejectedWorkspaceCommand } from './workspace-boundary.js';

describe('rejectedWorkspaceCommand', () => {
  it.each([
    'cf auth login',
    'cf --profile work auth create',
    'cd /home/project && cf auth list',
    'pnpm exec cf auth login',
    'npx cf auth whoami',
  ])('points the credential command %j at cloudflare_request', (command) => {
    expect(rejectedWorkspaceCommand(command)).toMatch(/cloudflare_request/);
  });

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
    'pkill -f workerd',
    'sudo killall computerd',
  ])('rejects the platform-state command %j', (command) => {
    expect(rejectedWorkspaceCommand(command)).toMatch(/platform runtime state/i);
  });

  it.each([
    'pnpm run validate',
    'pnpm dev',
    'node server.js &',
    'tsc --watch',
    'kill 4242',
    'pnpm add zod',
    'pnpm exec wrangler deploy --dry-run',
    'ls -la src',
    'rm -rf dist',
    'cd /home/project && pnpm run build 2>&1',
    'echo "start the dev server later"',
  ])('runs %j as asked', (command) => {
    expect(rejectedWorkspaceCommand(command)).toBeNull();
  });
});
