---
name: platform-status
description: Report the operational state of the CloudChef platform - whether the control-plane Worker is serving without throwing, whether the pinned default builder model is still current, connected Cloudflare accounts, workspace runtime staleness, users, and sign-in sessions. Use whenever asked for a platform update, a production status report, whether anything is broken or needs attention, or how CloudChef is doing.
---

# Platform status

## Run it

```bash
pnpm run ops
```

Add `pnpm run ops:json` when you need to reason over the result structurally rather than quote it.

It takes a few seconds: one combined read-only D1 statement against production, one dry-run Workers Logs query
(`cf o11y telemetry query`), and one Workers AI catalog read (`cf ai models list`), run one `cf` process at a time.

## The checks

Seven checks, in this order in `--json`:

| Check (`id`)                                  | What it answers                                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Control-plane Worker (`control-plane-worker`) | Invocation outcomes of the `cloudchef` Worker over the last 24 hours, from Workers Logs.                   |
| Builder model (`builder-model`)               | Whether the pinned default builder model is still served, and whether anything newer is worth a look.      |
| Cloudflare accounts (`cloudflare-accounts`)   | Connected accounts by status, and any connection missing its stored credential.                            |
| Workspace runtimes (`workspace-runtimes`)     | Each connected account's workspace runtime: status, and whether it is on this checkout's build.            |
| Users (`users`)                               | Total users and sign-ups this week against last week.                                                      |
| Sign-in sessions (`sessions`)                 | Unexpired sign-in sessions.                                                                                |
| Projects (`projects`)                         | Each project, whose it is, and its Artifacts repository or the GitHub one it is still to be imported from. |

## Reading the output

The first line after the header is the whole answer. Everything below it is grouped worst first:

| Group               | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `BROKEN`            | Something has failed and will not fix itself.                  |
| `NEEDS ATTENTION`   | Degraded, in progress, or stale - worth a decision.            |
| `COULD NOT BE READ` | The tool could not answer. Do **not** report these as healthy. |
| `HEALTHY`           | Nothing to do.                                                 |

The `Control-plane Worker` check counts invocation **outcomes**, not log lines. "None of them failed inside the Worker"
means no invocation ended in `exception`, `exceededCpu`, or any other non-benign outcome in the last 24 hours; it says
nothing about handled errors, logged warnings, or anything a request logged on its way to a 200, so do not report this
check as "no errors in the logs". The counts come from Workers Logs, which are head-sampled, so they are logged
invocations rather than every one; the fault share is what the status is judged on. When it names faults, the exception
text is one `cf o11y telemetry query` away (view `events`, filtered on `$workers.outcome`). A window with no
invocations at all is reported as needing attention, because this Worker serves cloudchef.build and fires a cron every
15 minutes.

The `Builder model` check is about the platform default only: `CLOUDFLARE_WORKERS_AI_MODEL` in
`app/lib/workers-ai-model.ts`, which every account runs on unless its admin chose its own default
(`cloudflare_connections.default_builder_model`). Models an account runs through its own AI Gateway provider keys
(BYOK: Anthropic, OpenAI, xAI, OpenRouter) are that account's choice and are not checked. A Workers AI model counts as
builder-capable here exactly when the runtime would offer it: native, text generation, function calling, a context
window at or above `MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS`, and listed in Pi's `cloudflare-workers-ai` catalog (the
`@earendil-works/pi-ai` package this checkout installs).

- `BROKEN`: the pin is not builder-capable in the account's live catalog, or Pi does not list it. Accounts without
  their own default are then building on whatever model the runtime offers first.
- `NEEDS ATTENTION`: `detail.candidates` names builder-capable models Cloudflare published after the pin. They are
  candidates for a reference build before re-pinning, not a ranking or a recommendation; report them as such.
- `HEALTHY`: nothing newer that the runtime would offer.

The catalog is read for whichever account `cf` resolves, so the answer is about that account's catalog.

The JSON mode carries the same information as `status` (`ok` / `attention` / `unknown` / `error`), `headline`, and a
`checks` array where each entry has `id`, `title`, `status`, `sentence`, `at`, `relative`, and a `detail` object.

Exit status is 0 whenever a report was produced, including an unhealthy one, and 1 when the control plane could not be
read at all - typically because `cf` is not logged in (`cf auth login`). Judge health from `status`/`headline`, not from the exit
code.

## What it is

`scripts/ops-report.mjs`, a plain ESM Node script. It reads production control-plane D1 with `cf d1 query` (the
database id comes from `cloudflare.config.ts`), the control-plane Worker's invocation outcomes from Workers Logs with
`cf o11y telemetry query` run as a dry run, which saves no query or result, and the Workers AI catalog with `cf ai models list`, all under the operator's existing `cf` login. Every statement is a `SELECT` and every command is a
read, checked against a read-only allowlist (`scripts/lib/ops-cf.mjs`) before it runs; the tool never writes, deletes, or upgrades anything, and holds no credential of its own. If the login can see more
than one account, set `CLOUDFLARE_ACCOUNT_ID` so `cf` knows which one to ask about.

Runtime staleness is measured against `app/generated/user-workspace-runtime.generated.ts`, the workspace runtime build
of the current checkout. If that generated file is absent the report says staleness is unknown rather than guessing;
`pnpm run generate:artifacts` restores it.

## When it is not the right tool

- Acting on a finding - upgrading a user's runtime, for instance. This tool only reports. Those actions live in the
  control plane under `app/lib/.server/`.
- Deployment or configuration verification. Use `pnpm run verify:production-config`, `pnpm run verify:stack`, or
  `pnpm run validate`.
