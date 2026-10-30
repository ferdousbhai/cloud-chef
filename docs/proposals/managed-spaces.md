# Proposal: managed spaces

Status: proposal (wave 1, item 4). Builds in wave 3, item 2. No product code changes with this document.

## Problem

Today a space is a Cloudflare connection (`cloudflare_connections`): a person's own account, or a team's account that
its admin connected. Someone with no Cloudflare account and no team invitation cannot build anything. The owner wants
such a person to pay CloudChef for hosting and model usage and ship apps without ever seeing Cloudflare.

This is per space, not per person. A team member with no Cloudflare account who wants personal projects pays for a
managed Personal space; their team's projects stay in the team's account. A person who connected their own account
never needs one.

Two other features depend on this:

- Showcase pages (`showcase-and-feed.md`) are public on the web and bring visitors with no Cloudflare account. Today
  sign-up is only through Cloudflare or a team invitation (`app/server-handlers/email-auth.ts`,
  `app/server-handlers/google-auth.ts` refuse an address with neither).
- Sharing a personal project with a friend (wave 3, item 1) runs the friend's workspace in the friend's own space (see
  "Sharing a project across accounts" below). A friend with no Cloudflare account needs a managed space first, so
  managed spaces are a prerequisite for sharing with newcomers.

## Summary of recommendations

| Choice               | Recommendation                                                                                      | Reason                                                                                                                                                                                                                                                                        | Alternative                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation            | One Cloudflare account per managed space, created by CloudChef through Cloudflare's Tenant API      | Every part of CloudChef (runtime Worker, Durable Objects, Containers, Workflows, D1, Artifacts namespace, AI Gateway, Workers Builds) is already keyed by account; a separate account keeps all of it unchanged and keeps one space's agent from reaching another's resources | Workers for Platforms dispatch namespaces: cheaper per space, but the workspace runtime needs Containers, Artifacts, Workers Builds and a per-space AI Gateway, which a dispatch namespace does not give, so it would be a second architecture |
| Payment provider     | Stripe (Checkout, Billing with meters, Customer Portal, Tax, Radar)                                 | Native prepaid credits and usage meters, card fingerprinting against repeat trials, hosted pages so CloudChef stores no card data                                                                                                                                             | Paddle as merchant of record, if the owner does not want to register for and remit sales tax/VAT; its usage billing is weaker                                                                                                                  |
| Pricing shape        | Monthly plan with included usage, plus prepaid top-ups; spending stops at zero                      | No surprise bills for non-technical people; no unpaid usage to chase; one number to show ("$6.40 of $20 left this month")                                                                                                                                                     | Pure pay-as-you-go invoiced monthly: lower barrier, but unpaid invoices and chargebacks after abuse                                                                                                                                            |
| Unit shown to people | Dollars                                                                                             | Honest and needs no explanation                                                                                                                                                                                                                                               | Abstract credits or "messages" (Lovable): easier to sell, but hides that a long turn costs more than a short one                                                                                                                               |
| Markup               | One markup on Cloudflare's and the model provider's list price (start at 30%)                       | One rule, easy to state and audit                                                                                                                                                                                                                                             | Per-meter markups (cheaper models, dearer containers): finer, harder to explain                                                                                                                                                                |
| Models               | AI Gateway Unified Billing in each managed account; Workers AI models as today                      | No provider key is copied into every managed account; cost lands on the account's Cloudflare invoice, which CloudChef already pays                                                                                                                                            | CloudChef's own provider keys stored as BYOK in each managed account's gateway: works today, but one key in hundreds of accounts, and a leak from any of them is a leak of all                                                                 |
| Billing gate         | A separate check, `spaceInGoodStanding`, beside `canUseConnection`                                  | `canUseConnection` answers who; standing answers whether spending may start; a suspended space still lets its owner read, download and move their code                                                                                                                        | Fold standing into `canUseConnection`: one check, but a person who ran out of money is locked out of their own code                                                                                                                            |
| Moving out later     | Hand the managed account itself to the person (make them its Super Administrator, CloudChef leaves) | Nothing is copied: projects, sites, databases, chats and history stay where they are; the space becomes an ordinary own-account space after a reconnect                                                                                                                       | Copy each project into a new account of theirs (`/api/projects/copy`, `cf d1 export`, R2 copy): works without Cloudflare's help, but chats (Durable Object SQLite) do not move                                                                 |

## Where things live

| Thing                                                                                                   | Where                                                                     |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Identity, sessions, the space's connection row, its encrypted Cloudflare credential, runtime locators   | Control-plane D1 (unchanged)                                              |
| Billing: Stripe ids, plan, balance, usage per day, suspensions, Stripe webhook receipts                 | Control-plane D1 (new tables below)                                       |
| Workspace runtime Worker, its D1, `ConversationAgent` and `ProjectWorkspace` Durable Objects, container | The managed space's own Cloudflare account (as today for any space)       |
| Project repositories (Artifacts `cloudchef` namespace), published sites, their D1/R2/KV, Workers Builds | The managed space's own Cloudflare account                                |
| Model calls                                                                                             | The managed account's `default` AI Gateway, Unified Billing or Workers AI |
| Card data                                                                                               | Stripe only                                                               |

CloudChef's own account (the control plane's) runs no user workload. Managed accounts are children of a CloudChef
parent organization in Cloudflare; their usage is invoiced to CloudChef.

## The amended invariant

Today (CLAUDE.md, ARCHITECTURE.md "Account Boundary"):

> User workloads, backing resources, and inference run only in the authenticated user's Cloudflare account. Missing
> user resources fail closed.

Proposed:

> User workloads, backing resources, and inference run only in the Cloudflare account of the space they belong to:
> the account its person or team connected, or, for a managed space, a Cloudflare account CloudChef created for that
> one space, which no other space shares and which CloudChef pays for and bills the space's owner. CloudChef's own
> control-plane account never runs user workloads. Missing space resources fail closed.

(The showcase proposal amends the same invariant once more, for showcase media only.)

## Data model (control-plane D1)

`cloudflare_connections` gains one column. A managed Personal space is an ordinary connection with `user_id` set; the
unique index on `user_id` already allows one per person, and someone with their own account never needs one.

```sql
-- Who pays Cloudflare for this space's account: the person or team who connected it, or CloudChef (a managed space).
ALTER TABLE cloudflare_connections ADD COLUMN hosted_by TEXT NOT NULL DEFAULT 'connected'
  CHECK (hosted_by IN ('connected', 'cloudchef'));
```

A managed account's credential is an account-owned API token CloudChef creates in that account through the Tenant
API, encrypted into `cloudflare_credentials` and named by `cloudflare_authorizations` exactly as an OAuth grant is, so
the credential broker (`app/server-handlers/runtime-credential.ts`) and everything downstream is unchanged.
`granted_oauth_scopes_json` records the token's permission groups.

```sql
CREATE TABLE managed_spaces (
  connection_id TEXT PRIMARY KEY REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  -- Who is billed: the person for a Personal space; a team's admin who started it for a team space (later).
  billed_user_id TEXT NOT NULL REFERENCES "user"(id),
  stripe_customer_id TEXT NOT NULL UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL CHECK (plan IN ('starter')),
  status TEXT NOT NULL CHECK (status IN ('setting_up', 'active', 'out_of_funds', 'suspended', 'closing', 'moved_out')),
  -- Money in millionths of a US dollar, so per-request costs add up without rounding.
  balance_micros INTEGER NOT NULL DEFAULT 0,
  period_start INTEGER,
  period_end INTEGER,
  suspended_reason TEXT CHECK (suspended_reason IN ('payment_failed', 'abuse', 'operator')),
  suspended_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- What each space used, a day and a meter at a time: Cloudflare's or the provider's list cost, and what was charged.
CREATE TABLE managed_usage_daily (
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  meter TEXT NOT NULL CHECK (meter IN (
    'workers_requests', 'workers_cpu_ms', 'durable_object_requests', 'durable_object_duration_gb_s',
    'd1_rows_read', 'd1_rows_written', 'd1_storage_gb_day', 'r2_class_a', 'r2_class_b', 'r2_storage_gb_day',
    'container_vcpu_s', 'container_memory_gib_s', 'container_disk_gb_s', 'artifacts_storage_gb_day',
    'workers_builds_minutes', 'model_cost'
  )),
  quantity REAL NOT NULL,
  cost_micros INTEGER NOT NULL,
  charged_micros INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('graphql_analytics', 'ai_gateway', 'runtime_report')),
  collected_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, day, meter)
);

-- Every change to a balance, so a balance can be recomputed and disputed: top-ups, plan credit, daily charges, refunds.
CREATE TABLE managed_ledger (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('plan_credit', 'top_up', 'usage', 'refund', 'adjustment')),
  amount_micros INTEGER NOT NULL,
  stripe_object_id TEXT,
  day TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_managed_ledger_space ON managed_ledger(connection_id, created_at DESC);

-- Stripe webhook deliveries already applied, so a redelivery changes nothing.
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

-- One trial per card and per verified email, whatever account it is tried from.
CREATE TABLE managed_trial_claims (
  card_fingerprint TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  claimed_at INTEGER NOT NULL
);
```

`organization_usage_daily` stays as it is (per-member counts for team admins).

## Billing and metering

**What is metered** (all in the managed account, read with the account's token):

- Workers requests and CPU time, Durable Object requests and duration, D1 rows and storage, R2 operations and storage,
  Containers vCPU, memory and disk seconds: Cloudflare's GraphQL Analytics API (`workersInvocationsAdaptive`,
  `durableObjectsInvocationsAdaptiveGroups`, `d1AnalyticsAdaptiveGroups`, `r2OperationsAdaptiveGroups`,
  `r2StorageAdaptiveGroups`, the Containers metrics datasets), collected hourly by the control plane's cron for every
  `hosted_by = 'cloudchef'` connection, written as the day's running total.
- Model usage: two sources. Near real time, the runtime's existing per-turn report (`/api/cloudflare/runtime-usage`)
  gains the turn's cost, computed from Pi's model cost table (input, output, cache read, cache write per million
  tokens) and charged at once. Daily, the managed account's AI Gateway analytics (cost per provider and model) is the
  record; a difference over 2% is logged for the operator.
- Artifacts storage and Workers Builds minutes, once Cloudflare exposes them per account; until then included in the
  plan.
- The Workers Paid subscription each managed account needs (Containers and Durable Objects require it) is CloudChef's
  fixed cost per space, covered by the plan price.

**Charging.** Each day's `charged_micros = cost_micros * 1.30` is written to `managed_ledger` and subtracted from
`balance_micros`. The plan adds its included amount at each period start (Stripe `invoice.paid`). Top-ups are Stripe
Checkout one-time payments. The monthly reconciliation compares the sum of `cost_micros` with Cloudflare's invoice
for each child account.

**Plan (to set with the owner).** One plan: $20 a month including $14 of usage at list price ($18.20 at the marked-up
rate), top-ups in $10 steps. A first month's trial with $5 of usage, needing a card (see Abuse).

**Hard stop.** At zero, the space is `out_of_funds`: new model turns, container starts and publishes are refused
with a plain message; published sites keep serving for 7 days (their requests still count, taking the balance
negative by at most that much), then their Workers are disabled until a top-up. Data is kept 30 days after a
cancellation, then the account is deleted.

What people read:

- "You've used $6.40 of your $20 this month."
- "You're out of credit. Add $10 to keep building. Your sites stay online for 7 more days."
- "Your sites are paused because there's no credit left. Add credit to turn them back on."

## Accounts: setting up a managed space

New endpoint module `app/server-handlers/managed-spaces.ts`:

1. Person signs in (Google or emailed link, now allowed without an invitation, see below) and chooses a username.
2. Home shows two choices: "Use your own Cloudflare account" (today's connect) and "Let CloudChef host it" (managed).
3. Managed: Stripe Checkout (subscription, card required; Radar on). On `checkout.session.completed` the webhook
   (`POST /api/billing/stripe-webhook`, signature checked, `stripe_events` for idempotency) starts a Workflow step
   sequence (new class beside `app/workflows/user-workspace-runtime-provisioning.ts`):
   - create the child account (Tenant API), subscribe it to Workers Paid, enable Unified Billing on its `default`
     AI Gateway (created as `app/lib/.server/cloudflare/ai-gateway-keys.ts` already does);
   - create an account-owned API token with exactly the permission groups CloudChef's OAuth scope profile asks for
     today, store it as the account's authorization;
   - insert the `cloudflare_connections` row (`user_id`, `hosted_by = 'cloudchef'`, `status = 'active'`) and the
     `managed_spaces` row;
   - the ordinary runtime provisioning Workflow then runs unchanged on the first open.
4. The person is sent to their projects home with "Your space is ready."

Steps are idempotent and named, so a retried Workflow never makes a second account.

## Fit with existing code

- **`canUseConnection`** (`app/lib/cloudflare/data/organization-access.server.ts`): unchanged. A managed Personal space
  has `user_id` set, so only its person may use it. A managed team space (later) has `org_id` set, and members are
  checked as today.
- **New `spaceInGoodStanding(db, connectionId)`**, same file: true for `hosted_by = 'connected'`; for a managed space,
  true only when `managed_spaces.status = 'active'`. Asked where spending starts:
  - the runtime-session request (`app/server-handlers/cloudflare-integration.ts`), which then issues a session
    marked read-only when false (history, download, move out still work);
  - `/api/cloudflare/runtime-access`, which every runtime already asks before each model turn in a team account;
    extended to ask in a managed account too (the runtime env carries `CLOUDCHEF_MANAGED_SPACE=1`, written by
    `app/lib/.server/cloudflare/user-account-api.ts` beside `CLOUDCHEF_SHARED_ACCOUNT`);
  - the credential broker (`app/server-handlers/runtime-credential.ts`) for publish and `cf` changes.
- **Runtimes keyed by (user, connection)**: unchanged. The runtime name is `sha256(accountId:userId)` for a person's
  own space; a managed Personal space is one.
- **Models**: `app/lib/.server/llm/pi-model-catalog.ts` lists, for a managed account, Workers AI plus the providers
  Unified Billing offers; `app/lib/.server/llm/pi-ai-models.ts` sends gateway models through the binding as today
  (to verify: Unified Billing through the Workers AI binding's `gateway('default')`, with no BYOK key). Settings,
  Models (`app/server-handlers/model-settings.ts`) hides key pasting for a managed space and keeps the default-model
  choice.
- **Sign-in**: `app/server-handlers/email-auth.ts` and `google-auth.ts` create an account for a verified email with
  no invitation (rate limited by `SIGN_IN_RATE_LIMITER`), with no space until the person chooses one.
- **Workspace switcher and Settings**: a managed space shows as "Personal (hosted by CloudChef)"; Settings gains a
  Billing section (balance, usage by kind in plain words, Add credit, Manage payment via Stripe's Customer Portal,
  Move to your own Cloudflare account).
- **Cron** (`app/server.ts` `scheduled`): hourly usage collection and balance checks
  (`app/lib/.server/billing/usage-collection.ts`, new).
- **Account deletion** (`app/server-handlers/account-deletion.ts`): a managed space's account is deleted after its
  export window, and the Stripe subscription cancelled.
- **Ops** (`scripts/ops-report.mjs`): managed spaces, balances, spaces near zero, suspensions, reconciliation gaps.
- **Docs**: ARCHITECTURE.md "Account Boundary" and "Accounts, Organizations, and Contexts"; CLAUDE.md invariant.

## Sharing a project across accounts

Owner's decision: when a personal project is shared with a friend, the friend's workspace runs in the friend's own
space (their own Cloudflare account or their managed space), not the owner's. The project's repository, its live site
and its builds stay in the owner's account. The friend's model use is paid by the friend's space.

**Data model.** `org_project_access` already records (project, person, role) and `findAccessibleProject` already
decides it. A personal project gets rows for the people it is shared with. Nothing records which space the friend
works from: the friend's runtime is the one for their current context, and each call names it.

**How a workspace reaches a repository in another account.** Today the runtime's `GitProxy`
(`user-workspace-runtime/src/git-proxy.ts`, `app/lib/.server/cloudflare/git-proxy.ts`) mints a short-lived Artifacts
token through its own `ARTIFACTS` binding, in its own account, and applies the push checks (incoming refs, no
`.env`/`.dev.vars`, main only fast-forwards, each workspace's refs private). A runtime in the friend's account has no
binding to the owner's account.

Recommended: the friend's runtime does not get a token for the owner's repository. For a project whose
`connection_id` is not the runtime's own, the friend's `GitProxy` forwards each git request to the control plane
(`POST /api/cloudflare/runtime-git/<project id>/…`, authenticated as every runtime route is, by identity headers and
secret). The control plane checks the friend's role (`findAccessibleProject`: edit for a push, view for a fetch) and
`canUseConnection` for the friend's own space, then forwards the request to the owner's runtime for the project's
connection, which runs the same `GitProxy` checks against its own repository with a token from its own binding. The
token never leaves the owner's account. Requests are streamed, not buffered, within the existing 48 MB limit.

Alternative, rejected: the control plane mints an Artifacts token in the owner's account (with the owner space's
authorization) and hands it to the friend's runtime. Simpler, but the friend controls their account and can deploy
a changed runtime that reads the token, so the token would reach the owner's repository with none of the push checks.

Consequences:

- The owner's runtime must be deployed and current to answer; the control plane provisions it on demand if missing,
  as a session request would. An owner whose space is suspended for non-payment still serves git (reading and
  pushing code is not spending), but builds of the pushed code are paid by the owner's account.
- Publishing goes through Workers Builds in the owner's account, which reads main from the repository, so a friend's
  push to main publishes the owner's site. This depends on wave 2, item 1 (one publish path for every project).
- Build status and site origins are already read by the control plane with the owner space's authorization
  (`/runtime-projects/status`, `/runtime-projects/site`); those calls accept a runtime whose connection differs from
  the project's when the caller has a role.
- `app/server-handlers/runtime-projects.ts` today refuses a project that is not on the runtime's connection; it is
  relaxed to "the project's connection, or a role on it".
- A friend with no Cloudflare account and no space must set up a managed space before opening the project. The
  invitation says so: "Sara shared Recipe Box with you. To work on it, set up your CloudChef space first. It costs
  $20 a month, and you can cancel any time." Owner choice below on whether the inviter can pay for that.

## Limits and quotas (starter plan, to tune)

| Limit                                  | Value                                          | Enforced by                                                                                                           |
| -------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Running workspace containers per space | 1 (one person, one runtime)                    | already one runtime per (user, connection)                                                                            |
| Container instance                     | the type workspaces use today; no larger       | `user-account-api.ts`                                                                                                 |
| Container hours a month                | 60 included; then charged; idle sleep as today | usage meter, standing check                                                                                           |
| Published sites                        | 10                                             | publish refuses the 11th                                                                                              |
| D1 storage across the space            | 2 GB                                           | daily check, publish refuses when over                                                                                |
| R2 storage                             | 10 GB                                          | daily check                                                                                                           |
| Model spend a day                      | $10 unless raised by the person                | runtime-access before each turn                                                                                       |
| Outbound email from apps               | off                                            | no `send_email` binding in the deploy settings for managed spaces (`app/lib/.server/cloudflare/deployment-config.ts`) |
| Custom domains                         | off in the first slice                         | not offered                                                                                                           |

## Abuse

- **Sign-up fraud and repeat trials**: card required before any workspace; Stripe Radar; one trial per card
  fingerprint and per verified email (`managed_trial_claims`); disposable-email domains refused; account creation
  rate limited per IP.
- **Crypto mining in workspace containers**: a container runs only for a session or a turn and sleeps when idle (as
  today); container time is charged, so mining spends the person's own balance; a container at sustained full CPU
  for 15 minutes with no turn and no terminal input is stopped and reported to the operator; outbound connections to
  known mining pool ports are blocked by the container's egress rules.
- **Phishing and malware on published sites**: sites are on the managed account's `workers.dev` subdomain, and abuse
  reports for it go to CloudChef as the parent; each publish's production URL is submitted to Cloudflare's URL
  Scanner and a verdict of phishing or malware disables the Worker and suspends the space (`suspended_reason =
'abuse'`) pending review; an operator can disable any managed account's Workers from `scripts/` (one read-write ops
  command, separate from the read-only ones).
- **Outbound email**: off for managed spaces (above); apps calling third-party mail APIs over HTTP cannot be blocked
  and are covered by the terms and the abuse report path.
- **Chargebacks**: a disputed payment suspends the space at once (`charge.dispute.created`).

## Moving a space to the person's own Cloudflare account

Recommended: hand over the account. Settings, Billing, "Move to your own Cloudflare account": CloudChef adds the
person's Cloudflare login as Super Administrator of the managed account, the person adds their own payment method in
Cloudflare, then connects it to CloudChef with OAuth as today (same `account_id`). On that callback the connection
becomes `hosted_by = 'connected'` with the new authorization, its `connection_generation` is bumped (the ordinary
reconnect, which redeploys the runtime when idle), CloudChef's API token is deleted, the account is detached from
CloudChef's parent, `managed_spaces.status = 'moved_out'` and the Stripe subscription is cancelled with a final usage
charge. Everything (projects, sites, databases, chats) stays in place.

To verify with Cloudflare before building: that a Tenant API child account can be detached from the parent and
billed to its new owner. If not, the fallback is copying: each project into the new account through the existing copy
path, published-site D1 with `cf d1 export`/import, R2 objects copied; chats do not move.

## First shippable slice

1. Sign-up without an invitation (Google, emailed link), username, no space yet.
2. Managed Personal spaces only, behind an allow-list of emails the owner adds.
3. Stripe Checkout for the starter plan, webhook, ledger, balance in Settings, Add credit.
4. Account creation through the Tenant API, account token, Workers Paid, Unified Billing gateway.
5. Model cost charged per turn from the runtime report; Cloudflare meters collected daily; hard stop at zero.
6. Limits above; outbound email off; URL Scanner on publish; operator suspend command.

Later: team managed spaces, moving out, custom domains, cross-account sharing (wave 3, item 1, which needs this slice
first for newcomers).

## Release order

1. **Release A (control plane only)**: migration adds `hosted_by` (with default) and the four new tables; sign-up
   without invitation behind the allow-list; billing endpoints and webhook; nothing reads `hosted_by` yet except
   setup. No runtime change.
2. **Release B (runtime upgrade)**: runtime reads `CLOUDCHEF_MANAGED_SPACE` and asks `runtime-access` before each turn
   in a managed account, and reports turn cost to `runtime-usage`. Bumps `USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION`,
   since the control plane's `runtime-access` answer gains standing and limits that an older runtime would ignore;
   runtimes upgrade through the ordinary window. Any user-workspace D1 change (none planned) must be additive and
   reaches runtimes only with this upgrade.
3. **Release C**: open the allow-list.
4. Later, cross-account sharing: control-plane `runtime-git` route first (A-type release), then the runtime's
   `GitProxy` forwarding (runtime upgrade with protocol bump).

Nothing is dropped, so no two-release drop is needed. If `cloudflare_connections.ai_billing_enabled` (still in the
table from 0021, its use dropped in 0031) is removed while rebuilding the table, that takes its own two releases.

## Decisions for the owner

| Decision                                                    | Recommendation                                            | Reason / alternative                                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Apply for Cloudflare's Tenant API (partner agreement)       | Yes, before any build work                                | The design depends on it / Workers for Platforms needs a second architecture         |
| Price and included usage                                    | $20 a month, $14 of list-price usage included, 30% markup | Covers each account's fixed Workers Paid cost / lower price with less included       |
| Stripe or a merchant of record                              | Stripe with Stripe Tax                                    | Best usage billing / Paddle if tax registration is unwanted                          |
| Can the person sharing a project pay for a newcomer's space | Not in the first slice                                    | Keeps one payer per space / a "pay for their space" option on the share dialog later |
| What happens to sites at zero credit                        | Keep serving 7 days, then pause                           | Visitors are not cut off by a missed top-up / pause at once, which bounds the loss   |
| Free tier                                                   | None                                                      | Every managed account has a fixed monthly cost / a trial month is the free step      |

## Risks

- **Tenant API access**: it is for Cloudflare partners. Without a partner agreement there is no per-space account,
  and the only alternative (one CloudChef account for everyone) is not acceptable, because an API token cannot be
  limited to one space's Workers, D1 databases and Durable Objects, so one person's agent could change another's.
  This is the first thing to settle with Cloudflare.
- **Fixed cost per space**: each account's Workers Paid subscription is paid whether or not the space is used. The
  plan price must cover it; a free tier is not possible on this design.
- **Unified Billing through the binding** is unverified; if it does not work, CloudChef's own provider keys go into
  each managed gateway as BYOK, with rotation tooling.
- **Metering lag**: GraphQL analytics arrive minutes to hours late; a space can go below zero by up to a day of
  Cloudflare usage. Model usage, the largest and fastest cost, is charged per turn.
- **Abuse reaches CloudChef**: CloudChef is the account holder of record for every managed account, so phishing
  complaints and legal requests come to it; the operator needs a takedown routine from the first release.
- **Tax and payments compliance** grow with paying users; Stripe Tax covers calculation, not registration.
