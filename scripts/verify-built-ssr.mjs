import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/**
 * The built server is a Workers bundle, so it statically imports
 * `cloudflare:workers` for the durable provisioning entrypoint. Node's ESM loader cannot resolve
 * that scheme, and workerd is not what this check is for: it exercises `fetch` route rendering,
 * never a Workflow. Stubbing the runtime base classes is enough — nothing here constructs the
 * entrypoint.
 */
const WORKERS_MODULE_STUB = 'export class WorkerEntrypoint {}; export class WorkflowEntrypoint {}';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') {
      return { url: `data:text/javascript,${encodeURIComponent(WORKERS_MODULE_STUB)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtServerPath = resolve(rootDir, 'dist/server/index.js');

const routeCases = [
  { path: '/', status: 200, content: 'What are we building?' },
  { path: '/settings', status: 200, content: 'Settings | CloudChef' },
  { path: '/chat/ssr-smoke-project', status: 200, content: 'Project | CloudChef' },
  { path: '/does-not-exist', status: 404, content: 'This page does not exist' },
];

async function verifyBuiltSsr() {
  if (!existsSync(builtServerPath)) {
    throw new Error('dist/server/index.js is missing; run pnpm run build before built SSR verification.');
  }

  const moduleUrl = `${pathToFileURL(builtServerPath).href}?ssr-smoke=${Date.now()}`;
  const worker = (await import(moduleUrl)).default;
  if (!worker || typeof worker.fetch !== 'function') {
    throw new Error('The built server does not export a Worker fetch handler.');
  }

  const errors = [];
  for (const routeCase of routeCases) {
    try {
      const response = await worker.fetch(
        new Request(`https://cloudchef.build${routeCase.path}`, { headers: { accept: 'text/html' } }),
        {},
      );
      const body = await response.text();
      if (response.status !== routeCase.status) {
        errors.push(`${routeCase.path} returned ${response.status}; expected ${routeCase.status}.`);
      }
      if (!response.headers.get('content-type')?.startsWith('text/html')) {
        errors.push(`${routeCase.path} did not return HTML.`);
      }
      if (!body.includes(routeCase.content)) {
        errors.push(`${routeCase.path} omitted its expected SSR content: ${JSON.stringify(routeCase.content)}.`);
      }
    } catch (error) {
      errors.push(
        `${routeCase.path} failed during built SSR: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  console.log(`Verified built SSR for ${routeCases.length} public and private route states.`);
}

await verifyBuiltSsr();
