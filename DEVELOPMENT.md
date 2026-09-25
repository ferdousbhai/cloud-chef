# Development

## Setup

```bash
nvm install
nvm use
corepack enable
pnpm install --frozen-lockfile
```

Node.js and pnpm versions are pinned in `.nvmrc` and `package.json`.

## Run Locally

```bash
pnpm run generate
pnpm run d1:migrations:apply:local
pnpm exec vite dev
```

This generates the route tree, Worker types, and bundled artifacts, applies the control-plane D1 migrations to a local
database, and serves the app at http://localhost:5173 with Vite and the Cloudflare Workers runtime. The home page, UI,
and `/api/health` work without any credentials. There is intentionally no `dev` package script: the production-config
verifier rejects scripts that start a local server.

Signing in and building apps need the `CLOUDFLARE_OAUTH_CLIENT_SECRET` and `CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY`
secrets and a Cloudflare OAuth client whose callback reaches your origin (see Configuration). Wrangler warns that they
are missing; that is expected for UI work.

## Verification

Run the same complete pipeline used by CI:

```bash
pnpm run validate
```

Useful narrower checks are `validate:root`, `validate:agent`, `validate:template`, `test`, `test:workerd`, `typecheck`,
and `lint`. Generated files produced by verification must leave the worktree clean.

`pnpm run verify:licenses` checks installed production dependencies against the reviewed license-expression allowlist
and verifies `public/THIRD_PARTY_LICENSES.txt`. Run `pnpm run licenses:generate` after a root production dependency
change. `pnpm run sbom:production` prints a deterministic SPDX 2.3 inventory suitable for a release artifact.

The generated-app template has an independent dependency graph and license artifact. Run
`pnpm --dir template run licenses:generate` after changing its production dependencies. These automated checks support
license diligence but do not replace legal review.

## Configuration

`wrangler.jsonc` is the source of truth for the control-plane Worker. It contains one D1 binding for identity,
authentication, encrypted Cloudflare credentials, connection metadata, and user-runtime discovery. Configure the two
declared secret values in Cloudflare; never store them in source or local environment files.

The checked-in D1 ID belongs to CloudChef production. Before provisioning a fork in another account, replace it with
`00000000-0000-0000-0000-000000000000`. The provisioner refuses to replace an unknown non-placeholder ID.

Builder references are not mirrored. Cloudflare's documentation is retrieved live by the `search_cloudflare_docs`
tool, and TanStack's skills are read from the project's own `node_modules`, so neither needs syncing or pinning. The
single exception is `app/lib/.server/llm/skills/frontend-design/`, which is vendored into this repository, bundled
into the Worker, and maintained by hand — edit it like any other source file. Its frontmatter `name` and `description`
are what the system prompt catalogs, so keep them accurate.

The OAuth callback is `https://<deployment-origin>/connect/return`. Keep its permissions aligned with
`CLOUDFLARE_OAUTH_SCOPES` in `wrangler.jsonc`. Those permissions let CloudChef create a workspace runtime in the
connected user's account; they do not add customer storage or compute to the CloudChef account.

`workers-builds.production.json` is the reviewed contract for Cloudflare dashboard build settings. Cloudflare does not
read it automatically. Mirror it in the `cloudchef` Worker's Builds settings:

- connect `ferdousbhai/cloud-chef`, production branch `main`, with non-production builds enabled
- set the build command to `pnpm run workers-builds:build` and deploy command to `pnpm run workers-builds:deploy`
- set non-production deploys to `pnpm run workers-builds:preview`
- use `/` as the root, include all paths, and enable build caching
- select `account-workers-builds-production`
- configure the pinned `NODE_VERSION`, `PNPM_VERSION`, `SKIP_DEPENDENCY_INSTALL=1`, and
  `CLOUDFLARE_OAUTH_CLIENT_ID`

The Workers Builds token needs only the permissions required to deploy the control-plane Worker, read its deployment,
and manage the control-plane D1 migrations. User workspace and generated-application resources are provisioned with the
connected user's authorization.

## Generated Artifacts

After editing `template/` or `user-workspace-runtime/`:

```bash
pnpm run generate:artifacts
```

Do not edit generated route trees, Worker binding types, `app/generated/user-workspace-runtime.generated.ts`, or the
generated Builder template module directly.

`template/scripts/lib/project-policy/generated-project-dependency-policy.json` is the single machine-readable source
for generated-project pnpm cooling, lifecycle-build approvals, and security overrides. The root and template verifiers
import it through `template/scripts/lib/project-policy.mjs`.

Client source maps are generated for internal diagnosis but excluded from the static upload by
`dist/client/.assetsignore`, following Cloudflare's
[static asset ignore contract](https://developers.cloudflare.com/workers/static-assets/binding/#ignoring-assets).
Worker source maps remain private Cloudflare uploads through
[`upload_source_maps`](https://developers.cloudflare.com/workers/observability/source-maps/). The validation pipeline
checks both sides of that policy.

## User Workspace Runtime

`pnpm run generate:artifacts` bundles `user-workspace-runtime/` together with its migrations and rebuilds the generated
application template snapshot in one deterministic step.
The control plane deploys that bundle into each connected user's Cloudflare account and provisions its D1 database,
`BuilderAgent` Durable Objects, `ProjectWorkspace` Durable Objects, and Container application there. The R2 permission
is retained for generated applications that request an R2 binding; project workspace bytes do not use an R2 backup
bucket.

There is intentionally no migration path from retired CloudChef-owned project or chat storage. A new deployment of
the control plane bootstraps its current D1 schema; each newly provisioned user runtime bootstraps the current
`user-workspace-migrations/` schema. Existing user runtimes are replaced when their recorded bundle digest differs from
the current digest.

Cloudflare Computer's SQLite VFS in `ProjectWorkspace` owns the current project. Its container backend projects the
same files through FUSE for shell commands, dependency installation, validation, preview, and generated-app deployment.
No ZIP, `DirectoryBackup`, or project copy passes through CloudChef.

## Deployment

The `cloudchef` Worker is connected to `ferdousbhai/cloud-chef` in Workers Builds. Its build settings are
specified in `workers-builds.production.json`: keep the dashboard commands, branch controls, build variables,
and token selection aligned with that file. Runtime secrets remain on the Worker and are not build variables.

Cloudflare Workers Builds validates every push. Non-production branches upload an undeployed Worker version. A push to
`main` runs the production deploy command only from the exact Workers Builds checkout, applies control-plane D1
migrations, publishes with the exact 40-character commit ID, and then probes `https://cloudchef.build/api/version` until
five consecutive responses report that commit, a live Worker version ID, configured OAuth bindings, and
`Cache-Control: no-store`.

Cloudflare Workers Builds is the normal production release path. The deploy wrapper also supports
`node scripts/deploy-production.mjs --local` for operator-driven bootstrap deployments from a clean `main` checkout
matching `origin/main`, with `CLOUDFLARE_OAUTH_CLIENT_ID` supplied in the environment. This local path deploys and
probes the built Worker; it does not run validation, apply migrations, or record a D1 recovery bookmark. Complete
those prerequisites separately before using it.

The Worker also answers on the retired `ghostbuild.dev` and `www.ghostbuild.dev` custom domains, which exist only to
redirect to the canonical `https://cloudchef.build` origin with the path and query intact. The first deploy that adds
these routes needs a Workers Builds token that may attach a custom domain in the `ghostbuild.dev` zone; attaching them
once by hand is equivalent, and later deploys are no-ops for routes that already exist.

For an emergency rollback from a clean checkout of current `main`, inspect and promote an immutable version:

```bash
pnpm exec wrangler versions view '<version-id>' --name cloudchef --json
pnpm exec wrangler rollback '<version-id>' --name cloudchef --message '<reason>'
```

Rollback changes the Worker version but not D1 data. If a release also changed control-plane data, use the recovery
bookmark recorded by the release pipeline. Run `pnpm run provision:production` separately only when bootstrapping the
control-plane D1 or intentionally reconciling its checked-in identifier.

Generated applications deploy independently inside the user workspace runtime. AppAgent projects provision `DB` for
application data and `AGENT_SECURITY_DB` for Agent sessions, retention, and inference accounting. CloudChef validates
the artifact, supplies the trusted bindings, and promotes the exact uploaded Worker version.

## Platform Status

There is no deployed admin dashboard. The operational state of production is reported from a terminal:

```bash
pnpm run ops        # Worker health, users, sessions, connected accounts, and runtime staleness
pnpm run ops:json   # the same report, structured for a coding agent
```

`scripts/ops-report.mjs` reads production control-plane D1 with `wrangler d1 execute cloudchef --remote --json` under
your existing Cloudflare authentication. It issues only `SELECT` statements and holds no secret of its own. Problems
are printed first; a check the tool could not answer is reported as unknown together with the reason, rather than as a
zero that reads as healthy. Runtime staleness is measured against `app/generated/user-workspace-runtime.generated.ts`,
so run `pnpm run generate:artifacts` first if the report says it has no build to compare against.

## Historical Evaluations

Experiment conclusions that still constrain the product are summarized in `scripts/evaluations/DECISIONS.md`. The
repository does not ship or support one-off remote evaluation Workers. Run launch-capacity measurements against the
exact release candidate in isolated staging infrastructure and retain provider telemetry with the release evidence.
