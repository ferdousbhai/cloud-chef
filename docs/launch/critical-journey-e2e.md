# Critical-journey browser gate

`pnpm run verify:built-browser` is the credential-free browser gate. It applies the local D1 migrations, starts the
built Worker with Vite preview, and drives desktop and mobile Chromium through the hydrated home page, signed-out
private routes, 404 handling, the public trust routes, the Worker's authorization boundaries, and the workspace
recovery surfaces. `pnpm run validate:public-beta` runs the complete repository validation and then this gate.

The gate runs on every pull request and every push to `main` through `.github/workflows/browser-gate.yml`, which
uploads `playwright-report/` and `test-results/` when it fails. Cloudflare Workers Builds still owns deployment and
runs `pnpm run validate`, but its build image documents no supported way to install Chromium and its system libraries
(`playwright install --with-deps` needs root `apt-get`), so the browser gate cannot run inside the deploy pipeline.
`pnpm run verify:workers-builds-config` fails when that workflow stops running `verify:built-browser`, so the gate
cannot quietly disappear. Install the browser once locally with `pnpm run test:e2e:install`.

Playwright retries are disabled everywhere, including CI: a retry hides flake instead of measuring it, and the launch
budget needs the observed failure rate. Every credential-free spec fails on console errors, uncaught page errors, and
failed requests through the shared `e2e/browser-diagnostics.ts` collector, which attaches what it saw to the report.

`e2e/workspace-recovery.spec.ts` uses explicit contract doubles for `/api/auth/session` and
`/api/cloudflare/runtime-session`; no Cloudflare account is involved. It proves the retry affordance and the typed
render for each workspace failure the Worker can return, that a reload during preparation keeps waiting instead of
dead-ending, and that a failing user-runtime data operation offers recovery. `e2e/authorization-boundaries.spec.ts`
drives unauthenticated and forged-session requests at the real built Worker, which enforces those boundaries itself.

Set `E2E_BASE_URL` to run the same credential-free smoke against a deployed candidate instead of a local preview:
`E2E_BASE_URL=https://candidate.example pnpm exec playwright test --project=chromium --project=mobile-chromium`.

The authenticated journey is intentionally separate because it creates billable Cloudflare resources and has no safe
automatic cleanup contract. Never hide it inside a general validation command. It also disables screenshots, traces,
and video, and does not use the diagnostics collector, because console text and request URLs there can contain live
cookies, capability tokens, prompts, generated code, preview URLs, and deployment identifiers; its release evidence is
the redacted line report and operator checklist.

`pnpm run test:e2e:critical` is the authenticated launch journey. It intentionally fails rather than skips when these
isolated-staging inputs are absent:

- `E2E_BASE_URL`: a dedicated HTTPS staging candidate; the suite rejects `cloudchef.build`.
- `E2E_AUTH_STORAGE_STATE`: a Playwright storage-state file for the test user. Store an in-repository file only under
  ignored `playwright/.auth/`; never commit or upload it.
- `E2E_STAGING_ACCOUNT`: the exact 32-character Cloudflare account ID. The suite reads the authenticated connection and
  refuses to continue unless it matches.
- `E2E_CANDIDATE_SHA`: the exact lowercase 40-character release commit SHA. The suite reads `/api/version` and refuses
  to continue against any other deployment.
- Optional `E2E_BUILD_PROMPT`: a deterministic prompt maintained with the staging fixture.

Before prompting, the journey opens a runtime session. CloudChef automatically creates or reconciles the isolated
Computer runtime when needed, then verifies it before the build starts.

The candidate journey has a one-hour whole-test budget because validation, preview, and deployment each cross isolated
Cloudflare build/runtime boundaries. The credential-free gate keeps the normal 60-second Playwright budget. The
authenticated journey runs once in desktop Chromium; the credential-free suite alone covers desktop and mobile, so a
candidate invocation cannot create duplicate deployments through the project matrix.

The current spec covers prompt admission, streaming and tool completion, the workbench, editor mutation and save, the
follow-up request that deploys the saved revision, revision identity between the deployment record and the durable
preview, and production URL reachability. A release operator must save its report with the candidate version.

The following #91 requirements remain external launch blockers because the repository has no safe contract for them:

- deterministic provisioning and idempotent cleanup of staging Workers, D1, R2, Containers, tunnels, Agents, and test
  records;
- a second genuinely connected Cloudflare identity and seeded project contract, so authorization coverage can reach
  cross-tenant open/mutate/preview/deploy attempts rather than only unauthenticated and forged-session ones;
- staging fault injection for the failures that live behind the agent socket in the user's own account: interrupted
  generation, preview build failure, validation repair, and deployment retry;
- a deployed-artifact readback that proves the published bytes carry the approved revision, which today is only
  observable inside the operator plane;
- correlation between a failed browser run and the server incident IDs, which the builder agent records inside the
  user-owned runtime and never returns to the credential-free gate;
- flake-rate history, runtime-budget trend, and production-candidate smoke scheduling.

Do not claim the authenticated gate is launch-ready until those contracts exist and the suite passes against the
candidate. Do not add an authentication bypass or point cleanup logic at unresolved resource names to make the test
green.
