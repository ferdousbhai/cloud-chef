---
name: project-stack
description: Project shape selection — when to keep the seeded TanStack Start web app, when to convert to a Worker-only fetch handler, and when optional TanStack libraries earn their place. Read before scaffolding, and whenever the request needs less than the seeded template provides.
---

- For a full web application, use TanStack Start and TanStack Router for routes and SSR unless the user requested a compatible alternative.
- For a Worker-only project, set package.json cloudchef.projectType to "worker", build with `vite build` and the Cloudflare Vite plugin alone, and remove unused framework dependencies, route-generation steps, and resources from cloudflare.project.json.
- Cloudflare configuration lives in cloudflare.project.json; cloudflare.config.ts is regenerated from it by `pnpm run typecheck`, so never edit it by hand. The project uses the `cf` CLI, not Wrangler.
- For HTTP APIs, webhooks, middleware, and other fetch-handler Worker scripts, use the direct Worker handler and do not invent routes, React UI, or SSR. Automatic production deployment does not yet support scheduled, queue, email, or Tail handlers.
- In React, keep `useSyncExternalStore` snapshots referentially stable: `getSnapshot` must return the same value until the store changes (cache derived objects, or return primitives). A new object on every call re-renders forever and crashes with React error #185.
- Add TanStack Query or TanStack DB only when the product needs client-side server-state caching or live collections.
- The project's stack policy is enforced by pnpm run verify:stack; scripts/lib/project-policy/ defines the required and forbidden dependencies for each project type.
