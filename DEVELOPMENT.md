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
secrets and a Cloudflare OAuth client whose callback reaches your origin (see Configuration). The Cloudflare Vite
plugin warns that they are missing; that is expected for UI work.

## Verification

Run the same complete pipeline used by CI:

```bash
pnpm run validate
```

`scripts/validate.mjs` runs the steps of `validate:root`, `validate:agent`, and `validate:template` side by side, one per
core (`VALIDATE_CONCURRENCY` overrides that), and stops at the first failure with that check's full output. Useful
narrower checks, run serially, are `validate:root`, `validate:agent`, `validate:template`, `test`, `test:workerd`,
`test:builder-agent`, `typecheck`, and `lint`. Generated files produced by verification must leave the worktree clean.

`test:builder-agent` (`vitest.builder-agent.config.ts`) runs the real `BuilderAgent` class in Node on an in-memory
Durable Object state, with the runtime's own D1 schema as `env.DB` and the ProjectWorkspace and Workers AI faked at
their boundary (`tests/builder-agent/harness.ts`). It is the place for tests of the agent's own call sites, such as
the runtime-activity gate every kind of work passes before it starts. The config adds the Agents SDK's decorator
transform, which the unit configuration leaves out.

`pnpm run verify:licenses` checks installed production dependencies against the reviewed license-expression allowlist
and verifies `public/THIRD_PARTY_LICENSES.txt`. Run `pnpm run licenses:generate` after a root production dependency
change. `pnpm run sbom:production` prints a deterministic SPDX 2.3 inventory suitable for a release artifact.

The generated-app template has an independent dependency graph and license artifact. Run
`pnpm --dir template run licenses:generate` after changing its production dependencies. These automated checks support
license diligence but do not replace legal review.

## Configuration

`cloudflare.config.ts` is the source of truth for the control-plane Worker, built by `vite build` with the Cloudflare
Vite plugin and deployed with the `cf` CLI. It contains one D1 binding (`DB`, schema in `migrations/`) holding:

- people, sign-in sessions, and sign-in state (Cloudflare OAuth, Google, and emailed-link tokens);
- Cloudflare connections with their encrypted credentials and OAuth grants, and each connection's default builder
  model (`default_builder_model`);
- teams (organizations), their members and invites, and daily per-member model usage (`organization_usage_daily`);
- GitHub projects: App installations, linked repositories, member access, and production requests;
- per-person settings such as AI Gateway content logging;
- user workspace runtime discovery, provisioning leases, and upgrade state, plus daily maintenance receipts.

It declares these secrets, which are configured in Cloudflare and never stored in source or local environment files:

- `CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY` — encrypts stored Cloudflare credentials; required.
- `CLOUDFLARE_OAUTH_CLIENT_SECRET` — the Cloudflare OAuth client's secret; required. Its client ID,
  `CLOUDFLARE_OAUTH_CLIENT_ID`, is a deploy-time variable, as is `COMMIT_SHA`.
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` — Sign in with Google; unset, that option reports itself
  unavailable.
- `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` (PKCS#8), `GITHUB_APP_SLUG` — CloudChef's
  GitHub App for team projects kept in GitHub; unset, those projects report themselves unavailable.

The checked-in D1 ID belongs to CloudChef production. Before provisioning a fork in another account, replace it with
`00000000-0000-0000-0000-000000000000`. The provisioner refuses to replace an unknown non-placeholder ID.

The builder's skills (`app/lib/.server/llm/builder-skills.ts`) are bundled into the Worker and served read-only
under `/__skills__/`: CloudChef's own `project-stack` (`app/lib/guidance/project-stack/SKILL.md`, edited by hand like
any other source file), and Cloudflare's official skills from github.com/cloudflare/skills, vendored at a pinned
commit into `app/lib/.server/llm/skills/cloudflare-skills.vendored.ts`. Do not edit that file; update it with
`pnpm run skills:sync` (optionally `-- <commit>`), which also names the skills it takes. Each skill's frontmatter
`name` and `description` are what the system prompt catalogs. The rest of Cloudflare's documentation is retrieved live
by the `search_cloudflare_docs` tool, and a framework's packaged skills are read from the project's own
`node_modules`, so neither needs syncing or pinning.

The OAuth callback is `https://<deployment-origin>/connect/return`. Keep its permissions aligned with
`CLOUDFLARE_OAUTH_SCOPES` in `cloudflare.config.ts`. Those permissions let CloudChef create a workspace runtime in the
connected user's account; they do not add customer storage or compute to the CloudChef account.

`workers-builds.production.json` is the reviewed contract for Cloudflare dashboard build settings. Cloudflare does not
read it automatically. Mirror it in the `cloudchef` Worker's Builds settings:

- connect `ferdousbhai/cloud-chef`, production branch `main`, with non-production builds enabled
- set the build command to `pnpm run workers-builds:build` and deploy command to `pnpm run workers-builds:deploy`
- set non-production deploys to `pnpm run workers-builds:branch`, which uploads nothing: a branch build only validates,
  since every version of the `cloudchef` Worker carries production's D1 and secrets (preview URLs are off for the same
  reason)
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

`vite build` writes the Worker as Build Output under `.cloudflare/output/`, which `cf deploy --prebuilt` ships. The
client build emits no source maps, so none can become a public static asset. Worker source maps sit in the bundle and
`cf deploy` uploads them as private
[Worker source maps](https://developers.cloudflare.com/workers/observability/source-maps/). `verify:static-assets`
checks both sides of that policy against the build output.

`cf build` refuses to run at a pnpm workspace root, so the repository builds with `vite build` directly.
`@cloudflare/vitest-plugin` and local D1 migrations still read Wrangler config, so they run against
`.cloudflare/wrangler.json`, a Wrangler-format copy of `cloudflare.config.ts` that `scripts/lib/cloudflare-config.mjs`
writes on demand; never edit it.

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

Cloudflare Workers Builds runs the full `pnpm run validate` on every non-production branch, which uploads an undeployed
Worker version (`scripts/workers-builds-checks.mjs`). A push to `main` validates too, inside the deploy step, so a
release that fails validation deploys and migrates nothing. Its build command only regenerates the checked-in outputs
and checks the release inputs. The deploy command (`scripts/deploy-production.mjs --workers-builds`), which runs only
from the exact Workers Builds checkout, then runs `pnpm run validate` with the exact 40-character commit ID and OAuth
client ID in the environment (which `cloudflare.config.ts` binds as plain-text vars). Validation's `build:check` is
therefore the release build itself, so there is no separate build and the gate costs only the checks beside it.
Validation includes the committed-config checks (`verify:production-config`, `verify:workers-builds-config`), so the
deploy step does not run them again; the account check (`provision:production:check`, which only reads the account
with `cf d1 list`) runs at the same time. Only after validation passes does it record a D1 restore point and apply the control-plane D1
migrations. It confirms the checkout is still clean, deploys that build with `cf deploy --prebuilt`, and then probes
`https://cloudchef.build/api/version` every 5 seconds, from the moment the deploy returns, until five consecutive
responses report that commit, a live Worker version ID, configured OAuth bindings, and `Cache-Control: no-store`.
Validation needs no browser (`verify:built-browser` is the GitHub Actions browser gate), so it runs in the Workers
Builds image exactly as it does on a branch build.

Cloudflare Workers Builds is the normal production release path. The deploy wrapper also supports
`node scripts/deploy-production.mjs --local` for operator-driven bootstrap deployments from a clean `main` checkout
matching `origin/main`, with `CLOUDFLARE_OAUTH_CLIENT_ID` supplied in the environment. This local path deploys and
probes the built Worker; it does not run validation, apply migrations, or record a D1 recovery bookmark. Complete
those prerequisites separately before using it.

The Worker also answers on the retired `ghostbuild.dev` and `www.ghostbuild.dev` custom domains, which exist only to
redirect to the canonical `https://cloudchef.build` origin with the path and query intact. The first deploy that adds
these routes needs a Workers Builds token that may attach a custom domain in the `ghostbuild.dev` zone; attaching them
once by hand is equivalent, and later deploys are no-ops for routes that already exist.

For an emergency rollback from a clean checkout of current `main`, inspect and promote an immutable version with `cf`,
which addresses the Worker by name and needs no config file:

```bash
pnpm exec cf workers versions list --worker-id cloudchef
pnpm exec cf workers versions get '<version-id>' --worker-id cloudchef
pnpm exec cf workers deployments create --worker cloudchef --body \
  '{"strategy":"percentage","versions":[{"version_id":"<version-id>","percentage":100}],"annotations":{"workers/message":"<reason>"}}'
```

Add `--dry-run` to the last command to see the request without sending it. Cloudflare refuses to roll back past a
change to the Worker's secrets unless `--bypass-deployment-checks` is given; check that the older version works with
the current secrets before passing it.

Rollback changes the Worker version but not D1 data. If a release also changed control-plane data, use the recovery
bookmark recorded by the release pipeline (below).

### Failed release after migrations

The deploy step records a D1 Time Travel bookmark (`d1:bookmark:production`, which prints a `### Pre-migration D1
restore point` summary and a `CLOUDCHEF_D1_RESTORE_RECEIPT` JSON line into the Workers Builds log) and then applies the
control-plane migrations. A failure before the bookmark changes nothing. A failure from the migrations on leaves
production in one of these states, and its error says which:

- **The migrations failed** ("may be partially migrated"). D1 has the migrations before the failing one, and
  possibly part of that one; `cf d1 migrations apply` records each migration only once it has succeeded. Nothing was
  deployed, so the previous Worker is still serving.
- **A later step failed** ("was already migrated through `<migration>`"): the built-output check or `cf deploy`
  (nothing deployed; the previous Worker serves against the new schema), or the live probe (the new Worker is
  deployed but did not report the release).

To recover, first read the failure; `pnpm exec cf d1 migrations list <database-id>` lists the
migrations not yet applied.
Migrations are written to be additive, so the previous Worker usually runs correctly on the new schema, and the fix is
to correct the cause and release again; the migrations step then applies only what is still pending. Restore the
bookmark only when the schema change itself is the problem, since a restore also discards every write made since it
was recorded:

```bash
pnpm exec cf d1 time-travel restore '<database-id>' --bookmark='<bookmark from the build log>'
```

The receipt's `databaseId` and the summary's restore command name the database. After a restore, roll the Worker back
(above) to a version built for the restored schema. Run `pnpm run provision:production` separately only when bootstrapping the
control-plane D1 or intentionally reconciling its checked-in identifier.

Generated applications deploy independently inside the user workspace runtime. AppAgent projects provision `DB` for
application data and `AGENT_SECURITY_DB` for Agent sessions, retention, and inference accounting. CloudChef validates
the artifact, supplies the trusted bindings, and promotes the exact uploaded Worker version.

## Platform Status

There is no deployed admin dashboard. The operational state of production is reported from a terminal:

```bash
pnpm run ops        # Worker health, builder model, users, sessions, connected accounts, and runtime staleness
pnpm run ops:json   # the same report, structured for a coding agent
pnpm run ops:session -- <chat id | user email | user id>   # one member's recent session, reconstructed
```

`scripts/ops-session.mjs` reads, with `cf` and `gh` only, what an operator otherwise gathers by hand when someone
reports a problem: control-plane D1, the workspace's own D1 (found with `cf d1 list` in the runtime's account), dry-run
Workers Logs queries for the workspace Worker, AI Gateway logs filed under the chat, and the member branch's commits
and check runs for a GitHub project. It refuses any `cf` command outside a read-only allowlist, and a source it cannot
read is reported as unknown with the reason. Conversation content exists only for people who kept AI Gateway logging on.

`scripts/ops-report.mjs` reads production control-plane D1 with `cf d1 query`, the control-plane Worker's invocation
outcomes from Workers Logs with a dry-run `cf o11y telemetry query`, and the Workers AI catalog with
`cf ai models list`, all under your existing `cf` login. It issues only `SELECT` statements and holds no secret of its own. Problems
are printed first; a check the tool could not answer is reported as unknown together with the reason, rather than as a
zero that reads as healthy. Runtime staleness is measured against `app/generated/user-workspace-runtime.generated.ts`,
so run `pnpm run generate:artifacts` first if the report says it has no build to compare against.

## Historical Evaluations

Experiment conclusions that still constrain the product are summarized in `scripts/evaluations/DECISIONS.md`. The
repository does not ship or support one-off remote evaluation Workers. Run launch-capacity measurements against the
exact release candidate in isolated staging infrastructure and retain provider telemetry with the release evidence.
