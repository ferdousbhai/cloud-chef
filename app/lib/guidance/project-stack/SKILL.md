---
name: project-stack
description: Project shape selection — when to keep the seeded TanStack Start web app, when to convert to a Worker-only fetch handler, and when optional TanStack libraries earn their place. Read before scaffolding, and whenever the request needs less than the seeded template provides.
---

- For a full web application, use TanStack Start and TanStack Router for routes and SSR unless the user requested a compatible alternative.
- For a Worker-only project, set package.json cloudchef.projectType to "worker", use a Wrangler dry-run build targeting dist/worker, and remove unused framework dependencies, route-generation steps, and bindings.
- For HTTP APIs, webhooks, middleware, and other fetch-handler Worker scripts, use the direct Worker handler and do not invent routes, React UI, or SSR. Automatic production deployment does not yet support scheduled, queue, email, or Tail handlers.
- Add TanStack Query or TanStack DB only when the product needs client-side server-state caching or live collections.
- The project's stack policy is enforced by pnpm run verify:stack; scripts/lib/project-policy/ defines the required and forbidden dependencies for each project type.
