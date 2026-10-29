import agents from 'agents/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vite.config.ts';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The ConversationAgent harness: the real `ConversationAgent` class in Node, on an in-memory Durable Object state
 * (`tests/conversation-agent/harness.ts`). It needs what the unit configuration leaves out: the Agents SDK's
 * decorator transform (`@callable`), and the Agents SDK loaded through Vite so its `cloudflare:*` imports resolve
 * to the test shims.
 */
export default defineConfig((env) =>
  mergeConfig(base(env), {
    plugins: [agents()],
    resolve: {
      alias: { 'cloudflare:email': fromRoot('./tests/conversation-agent/cloudflare-email-shim.ts') },
    },
    test: { include: ['tests/conversation-agent/**/*.integration.ts'] },
  }),
);
