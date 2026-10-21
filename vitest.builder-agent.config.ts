import agents from 'agents/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vite.config.ts';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The BuilderAgent harness: the real `BuilderAgent` class in Node, on an in-memory Durable Object state
 * (`tests/builder-agent/harness.ts`). It needs what the unit configuration leaves out: the Agents SDK's
 * decorator transform (`@callable`), and the Agents SDK and AI Chat loaded through Vite so their
 * `cloudflare:*` imports resolve to the test shims.
 */
export default defineConfig((env) =>
  mergeConfig(base(env), {
    plugins: [agents()],
    resolve: {
      alias: { 'cloudflare:email': fromRoot('./tests/builder-agent/cloudflare-email-shim.ts') },
    },
    ssr: { noExternal: ['@cloudflare/ai-chat'] },
    test: { include: ['tests/builder-agent/**/*.integration.ts'] },
  }),
);
