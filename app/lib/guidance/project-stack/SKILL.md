---
name: project-stack
description: The shape of a CloudChef starter app and the rules its checks enforce — its files and entrypoints, cloudflare.project.json, adding a UI framework or converting to a Worker-only project. Read before scaffolding or adding a framework. For Cloudflare platform guidance, read Cloudflare's own skills (workers-best-practices, durable-objects, agents-sdk, cf-cli).
---

The starter is a Cloudflare Worker web app with no framework, built by Vite and the Cloudflare Vite plugin and deployed with `cf`:

- `index.html`, `src/main.ts`, and `src/styles.css` are the browser client.
- `src/application.ts` is the request handler. It answers `/api/*` and serves the built client through `env.ASSETS`.
- `src/plain-server.ts` (and `src/server.ts` once the Agent capability is enabled) wrap `src/application.ts` with CloudChef's security headers. Change the application, never these entrypoints.
- Application code reaches bindings through `src/app-bindings.ts`, never `cloudflare:workers`.

Choose the smallest shape that fits:

- Static pages or light interactivity: keep the starter; add API routes in `src/application.ts`.
- A UI framework (React, Vue, Svelte, Solid): add it and its Vite plugin at their latest releases, put the plugin in `frameworkPlugins` in `vite.config.ts`, and mount the app from `src/main.ts` (or `src/main.tsx`).
- Server rendering or file-based routing (TanStack Start, React Router framework mode): export the framework's request handler from `src/application.ts`, add its Vite plugins to `frameworkPlugins`, and remove `index.html` and `src/main.ts` when the framework renders the document.
- Worker-only (HTTP APIs, webhooks): set package.json `cloudchef.projectType` to "worker", make `src/server.ts` the fetch handler and the `cloudflare.project.json` entrypoint, and remove `"assets"`, the client files, and unused resources. Automatic deployment does not yet support scheduled, queue, email, or Tail handlers.

Rules the project's checks enforce:

- Keep `productionModuleSecurityPlugin` first and `cloudflare()` last in `vite.config.ts`.
- Cloudflare configuration lives in `cloudflare.project.json`; `cloudflare.config.ts` is regenerated from it by `pnpm run typecheck`, so never edit it by hand. Keep its d1, r2, and kv entries.
- `pnpm run verify:stack` enforces the stack policy; `scripts/lib/project-policy/` lists the required and forbidden dependencies per project type.
- After installing a framework, read its packaged guidance in `node_modules` so the code matches the installed version.
