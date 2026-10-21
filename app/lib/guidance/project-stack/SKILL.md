---
name: project-stack
description: How a CloudChef starter app is wired and what its checks enforce — its entrypoints, where a UI framework plugs in, Worker-only projects, and cloudflare.project.json. Read before adding a framework or changing the project's shape.
---

The starter is a framework-free Worker web app, built by Vite with the Cloudflare Vite plugin and deployed with `cf`.

- `src/application.ts` is the request handler; it answers `/api/*` and serves the built client through `env.ASSETS`. The client is `index.html`, `src/main.ts`, `src/styles.css`.
- `src/plain-server.ts` (and `src/server.ts` once the Agent capability is enabled) wrap it with CloudChef's security headers. Change the application, never these entrypoints.
- Reach bindings through `src/app-bindings.ts`, never `cloudflare:workers`.
- A UI framework's Vite plugin goes in `frameworkPlugins` in `vite.config.ts`. A server-rendering framework's request handler is exported from `src/application.ts`; remove `index.html` and `src/main.ts` when it renders the document.
- In `vite.config.ts`, `productionModuleSecurityPlugin` stays first and `cloudflare()` last.
- Worker-only: set package.json `cloudchef.projectType` to "worker", make `src/server.ts` the fetch handler and the `cloudflare.project.json` entrypoint, and drop `"assets"` and the client files. Automatic deployment does not yet support scheduled, queue, email, or Tail handlers.
- Configuration lives in `cloudflare.project.json` (keep its d1, r2, and kv entries); `cloudflare.config.ts` is regenerated from it by `pnpm run typecheck`, never edited.
- Every deployment of the app goes to the same Worker, address, database, bucket, and namespace, so their data carries over; a subchat starts from its parent's files but is published as its own app, with its own address and data. The preview is a separate app with its own Worker, address, databases, bucket, and namespace, kept the same way, so nothing tried there reaches production's data. Each `migrations/` file applies once to each database: make every schema change in a new numbered migration that works on the data already there, never by editing one that has deployed, which the next deployment refuses. `migrations/0001_app_data.sql` is the starter's placeholder, applied with the first preview, so schema goes in `0002_…` onward whatever its comment says.
- `pnpm run verify:stack` enforces the dependency policy in `scripts/lib/project-policy/`.
