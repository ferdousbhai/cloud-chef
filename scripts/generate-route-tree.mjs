import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'vite';

// The TanStack Start vite plugin is the only writer of `app/routeTree.gen.ts`, so anything that
// needs a current route tree without running a build — `typecheck` above all — has to ask that
// plugin for it rather than a second generator that would drift from it.
//
// The plugin's route-tree codegen hangs off vite's `configResolved` hook, which `resolveConfig`
// runs for every plugin. So resolving the real `vite.config.ts` is enough: no bundling, no dev
// server, and no chance of the generated tree differing from the one `vite build` would write.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await resolveConfig({ configFile: resolve(root, 'vite.config.ts'), root }, 'build', 'production', 'production');
