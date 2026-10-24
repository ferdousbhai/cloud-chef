---
name: project-stack
description: How a CloudChef starter app is wired and what its checks enforce — its entrypoints, where a UI framework plugs in, Worker-only projects, and cloudflare.project.json. Read before adding a framework or changing the project's shape.
---

The starter is a framework-free Worker web app, built by Vite with the Cloudflare Vite plugin and deployed with `cf`.

- `src/application.ts` is the request handler; it answers `/api/*` and serves the built client through `env.ASSETS`. The client is `index.html`, `src/main.ts`, `src/styles.css`.
- `src/plain-server.ts` (and `src/server.ts` once the Agent capability is enabled) are the Worker entrypoints; they wrap the application with CloudChef's security headers.
- Bindings are reached through `src/app-bindings.ts`; the production build rejects application code that imports `cloudflare:workers`.
- A UI framework's Vite plugin goes in `frameworkPlugins` in `vite.config.ts`. A server-rendering framework's request handler is exported from `src/application.ts`, and `index.html` and `src/main.ts` are no longer needed when it renders the document.
- Worker-only: package.json `cloudchef.projectType` is "worker", `src/server.ts` is the fetch handler and the `cloudflare.project.json` entrypoint, and there is no `"assets"` entry or client. Automatic deployment does not yet support scheduled, queue, email, or Tail handlers.
- Configuration lives in `cloudflare.project.json`, whose d1, r2, and kv entries validation and deployment require; `cloudflare.config.ts` is regenerated from it by `pnpm run typecheck`.
- Every deployment of the app goes to the same Worker, address, database, bucket, and namespace, so their data carries over, whichever of the chat's conversations deploys it. The preview is a separate app with its own Worker, address, databases, bucket, and namespace, kept the same way, so nothing tried there reaches production's data. Each `migrations/` file applies once to each database, to the data already there, and a deployment refuses a migration edited after it deployed. `migrations/0001_app_data.sql` is the starter's placeholder, applied with the first preview.
- `pnpm run verify:stack` enforces the dependency policy in `scripts/lib/project-policy/`.
