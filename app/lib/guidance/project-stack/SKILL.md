---
name: project-stack
description: How a CloudChef starter app is wired and what its checks enforce — its entrypoints, where a UI framework plugs in, Worker-only projects, cloudflare.project.json, and the Cloudflare options for AI in the app. Read before adding a framework or changing the project's shape.
---

The starter is a framework-free Worker web app, built by Vite with the Cloudflare Vite plugin and deployed with `cf`.

- `src/application.ts` is the request handler; it answers `/api/*` and serves the built client through `env.ASSETS`. The client is `index.html`, `src/main.ts`, `src/styles.css`.
- `src/plain-server.ts` (and `src/server.ts` once the Agent capability is enabled) are the Worker entrypoints; they wrap the application with CloudChef's security headers.
- Bindings are reached through `src/app-bindings.ts`; the production build rejects application code that imports `cloudflare:workers`.
- A UI framework's Vite plugin goes in `frameworkPlugins` in `vite.config.ts`. A server-rendering framework's request handler is exported from `src/application.ts`, and `index.html` and `src/main.ts` are no longer needed when it renders the document.
- Worker-only: package.json `cloudchef.projectType` is "worker", `src/server.ts` is the fetch handler and the `cloudflare.project.json` entrypoint, and there is no `"assets"` entry or client. Automatic deployment does not yet support scheduled, queue, email, or Tail handlers.
- Configuration lives in `cloudflare.project.json`, whose d1, r2, and kv entries validation and deployment require; `cloudflare.config.ts` is regenerated from it by `pnpm run typecheck`.
- Every deployment of the app goes to the same Worker, address, database, bucket, and namespace, so their data carries over, whichever of the chat's conversations deploys it. Each `migrations/` file applies once to each database, to the data already there, and a deployment refuses a migration edited after it deployed. `migrations/0001_app_data.sql` is the starter's placeholder, applied with the first deployment.
- `pnpm run verify:stack` checks the project's shape and toolchain with `scripts/lib/project-policy/`: required packages, Node and pnpm pins, the reviewed `pnpm-workspace.yaml` build and override policy, and no Vite build-time environment values (other than Vite's own build flags) in source, since Vite writes them into the published browser files.
- In the Worker, `process.env` holds the Worker's text and JSON variables and its secrets, as `env` does (`nodejs_compat` at the template's compatibility date).

## AI in the app

- Workers AI: the `AI` binding, `env.AI.run(model, input)`, runs models in the account. The Agent capability (`pnpm run agent:enable`) adds the binding, with `agents`, `ai`, and `workers-ai-provider`.
- Workers AI also answers OpenAI-shaped requests at `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1` (for example `/chat/completions`), authorized by a Cloudflare API token.
- Other providers' models (OpenAI, Anthropic, Google, and more) go through the account's AI Gateway, `default`, which holds the provider keys the account added in CloudChef Settings, Models (BYOK); the gateway adds the stored key, so requests carry none.
  - From the Worker: `env.AI.gateway("default").run({ provider, endpoint, headers, query })` sends `query` as the provider's own request body to its `endpoint` (for example `provider: "openai", endpoint: "chat/completions"`).
  - A provider's SDK works with its base URL set to `await env.AI.gateway("default").getUrl("openai")` (`https://gateway.ai.cloudflare.com/v1/{account_id}/default/openai`), no provider key, and a `cf-aig-authorization: Bearer <AI Gateway token>` header, the token kept as a Worker secret.
  - `env.AI.run(model, input, { gateway: { id: "default" } })` sends a Workers AI call through the same gateway.
