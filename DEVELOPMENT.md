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

`scripts/validate.mjs` runs every check side by side, one per core, and stops at the first failure with that check's
full output; `VALIDATE_CONCURRENCY=1 pnpm run validate` runs them serially. Useful narrower checks are `test`,
`test:workerd`, `test:builder-agent`, `typecheck`, and `lint`. Generated files produced by verification must leave the
worktree clean.

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
`00000000-0000-0000-0000-000000000000`. `pnpm run provision:production` bootstraps the control-plane D1 or reconciles
that identifier, and refuses to replace an unknown non-placeholder ID.

The OAuth callback is `https://<deployment-origin>/connect/return`. Keep its permissions aligned with
`CLOUDFLARE_OAUTH_SCOPES` in `cloudflare.config.ts`. Those permissions let CloudChef create a workspace runtime in the
connected user's account; they do not add customer storage or compute to the CloudChef account.

## Generated Artifacts

After editing `template/` or `user-workspace-runtime/`:

```bash
pnpm run generate:artifacts
```

This bundles `user-workspace-runtime/` with its migrations and rebuilds the generated application template snapshot in
one deterministic step. Do not edit generated files directly: the route trees, Worker binding types,
`app/generated/user-workspace-runtime.generated.ts`, the generated Builder template module, and
`.cloudflare/wrangler.json` (the Wrangler-format copy of `cloudflare.config.ts` that `@cloudflare/vitest-plugin` and
local D1 migrations read).

## Deployment

The `cloudchef` Worker is connected to `ferdousbhai/cloud-chef` in Workers Builds. `workers-builds.production.json` is
the reviewed contract for its dashboard build settings; Cloudflare does not read it, so mirror it in the Worker's Builds
settings:

- production branch `main`, with non-production builds enabled
- build command `pnpm run workers-builds:build`, deploy command `pnpm run workers-builds:deploy`
- non-production deploy command `pnpm run workers-builds:branch`, which uploads nothing: every version of the
  `cloudchef` Worker carries production's D1 and secrets (preview URLs are off for the same reason)
- root `/`, all paths included, build caching on
- build token `account-workers-builds-production`, which needs only the permissions to deploy the Worker, read its
  deployment, and manage the control-plane D1 migrations
- the pinned `NODE_VERSION`, `PNPM_VERSION`, `SKIP_DEPENDENCY_INSTALL=1`, and `CLOUDFLARE_OAUTH_CLIENT_ID`

Runtime secrets remain on the Worker and are not build variables. User workspace and generated-application resources
are provisioned with the connected user's authorization.

Cloudflare Workers Builds runs the full `pnpm run validate` on every non-production branch
(`scripts/workers-builds-checks.mjs`), checks its build identity and clean checkout but not the production branch
(`deploy-production.mjs --check-workers-builds`), and uploads nothing. A push to `main` validates too, inside the deploy step, so a
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

Generated applications deploy independently inside the user workspace runtime. AppAgent projects provision `DB` for
application data and `AGENT_SECURITY_DB` for Agent sessions, retention, and inference accounting. CloudChef validates
the artifact, supplies the trusted bindings, and promotes the exact uploaded Worker version.

### Failed release after migrations

The deploy step records a D1 Time Travel bookmark (`d1:bookmark:production`) in the Workers Builds log, under
"Pre-migration D1 restore point", before it applies the control-plane migrations. Migrations are additive, so the usual
fix is to correct the cause and release again; restore the bookmark only when the schema change itself is the problem
(a restore discards every write made since it was recorded), then roll the Worker back (above) to a version built for
the restored schema:

```bash
pnpm exec cf d1 time-travel restore '<database-id>' --bookmark='<bookmark from the build log>'
```

## Platform Status

The operational state of production is reported from a terminal:

```bash
pnpm run ops        # Worker health, builder model, users, sessions, connected accounts, and runtime staleness
pnpm run ops:json   # the same report, structured for a coding agent
pnpm run ops:session -- <chat id | user email | user id>   # one member's recent session, reconstructed
```

`scripts/ops-session.mjs` reads, with `cf` and `gh` only, what an operator otherwise gathers by hand when someone
reports a problem: control-plane D1, the workspace's own D1 (found with `cf d1 list` in the runtime's account), dry-run
Workers Logs queries for the workspace Worker, AI Gateway logs filed under the chat, and, for a GitHub project, the
commits and check runs on the conversation's branch (the latest of the member's: which one is the chat's isn't recorded). It refuses any `cf` command outside a read-only allowlist, and a source it cannot
read is reported as unknown with the reason. Conversation content exists only for people who kept AI Gateway logging on.

`scripts/ops-report.mjs` is read-only under your `cf` login; `.claude/skills/platform-status/SKILL.md` describes its
checks and how to read them. Runtime staleness is measured against `app/generated/user-workspace-runtime.generated.ts`,
so run `pnpm run generate:artifacts` first if the report says it has no build to compare against.

## Decisions

Experiment and review conclusions that still constrain the product are in `docs/DECISIONS.md`.
