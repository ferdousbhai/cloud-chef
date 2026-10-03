---
name: project-stack
description: Project shape and framework selection — the seeded framework-free Worker web app, when to add a UI framework (React, Vue, Svelte, TanStack Start, React Router, Hono) and how to wire it, and when to convert to a Worker-only fetch handler. Read before scaffolding or adding a framework.
---

The seed is a Cloudflare Worker web app with no framework. Vite and the Cloudflare Vite plugin build it, and `cf` deploys it:

- `index.html`, `src/main.ts`, and `src/styles.css` are the browser client.
- `src/application.ts` is the application's request handler. It answers `/api/*` and serves the built client through `env.ASSETS`.
- `src/plain-server.ts` (and `src/server.ts` once the Agent capability is enabled) wrap `src/application.ts` with CloudChef's security headers. Change the application, never these entrypoints.
- Pages and API requests reach the Worker first; Vite's hashed bundles under `/assets` are served statically. That is why `cloudflare.project.json` declares `"assets": true` for a web app.

Choose the smallest shape that fits the product:

- Static pages or light interactivity: keep the framework-free seed. Write HTML, CSS, and TypeScript; add API routes in `src/application.ts`.
- A component-based single-page app: add the framework and its Vite plugin at their latest releases, put the plugin in `frameworkPlugins` in `vite.config.ts`, and mount the app from `src/main.ts` (or `src/main.tsx`). React: `pnpm add react react-dom` and `pnpm add -D @vitejs/plugin-react @types/react @types/react-dom`, `react()` in `frameworkPlugins`, and `"jsx": "react-jsx"` in tsconfig. Vue, Svelte, and Solid follow the same pattern with their official Vite plugins.
- Server rendering or file-based full-stack routing: add TanStack Start or React Router (framework mode), following that framework's Cloudflare Workers guide. Export its request handler from `src/application.ts` (TanStack Start: `import handler from "@tanstack/react-start/server-entry"` and `export default { fetch: (request: Request) => handler.fetch(request) }`), add its Vite plugins to `frameworkPlugins`, and remove `index.html` and `src/main.ts` when the framework renders the document.
- A richer API: add Hono and route `/api/*` through it inside `src/application.ts`, falling back to `env.ASSETS` for pages.
- A Worker-only project (HTTP APIs, webhooks, middleware): set package.json `cloudchef.projectType` to "worker", make `src/server.ts` the fetch handler and the `cloudflare.project.json` entrypoint, remove `"assets"`, the client files, unused dependencies, and unused resources. Do not invent routes, UI, or SSR. Automatic production deployment does not yet support scheduled, queue, email, or Tail handlers.

Rules for every shape:

- Keep `productionModuleSecurityPlugin` first and `cloudflare()` last in `vite.config.ts`. Application code reaches bindings through `src/app-bindings.ts`, never `cloudflare:workers`.
- After installing a framework, read its packaged guidance from the project (for example `node_modules/@tanstack/react-start/skills/`) and Cloudflare's guides through `search_cloudflare_docs`, so the code matches the installed version.
- Cloudflare configuration lives in cloudflare.project.json; cloudflare.config.ts is regenerated from it by `pnpm run typecheck`, so never edit it by hand. The project uses the `cf` CLI, not Wrangler.
- In React, keep `useSyncExternalStore` snapshots referentially stable: `getSnapshot` must return the same value until the store changes (cache derived objects, or return primitives). A new object on every call re-renders forever and crashes with React error #185.
- Add client data libraries (TanStack Query, TanStack DB) only when the product needs client-side server-state caching or live collections.
- The project's stack policy is enforced by pnpm run verify:stack; scripts/lib/project-policy/ defines the required and forbidden dependencies for each project type.
