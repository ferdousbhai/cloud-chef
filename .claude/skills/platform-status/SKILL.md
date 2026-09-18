---
name: platform-status
description: Report the operational state of the CloudChef platform - whether the control-plane Worker is serving without throwing, connected Cloudflare accounts, workspace runtime staleness, users, and sign-in sessions. Use whenever asked for a platform update, a production status report, whether anything is broken or needs attention, or how CloudChef is doing. Replaces the retired admin.cloudchef.build dashboard.
---

# Platform status

## Run it

```bash
pnpm run ops
```

Add `pnpm run ops:json` when you need to reason over the result structurally rather than quote it.

It takes a few seconds; it runs one combined read-only D1 statement against production plus the Workers analytics read.

## Reading the output

The first line after the header is the whole answer. Everything below it is grouped worst first:

| Group               | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `BROKEN`            | Something has failed and will not fix itself.                  |
| `NEEDS ATTENTION`   | Degraded, in progress, or stale - worth a decision.            |
| `COULD NOT BE READ` | The tool could not answer. Do **not** report these as healthy. |
| `HEALTHY`           | Nothing to do.                                                 |

A `COULD NOT BE READ` entry naming a table that "does not exist in production yet" means that migration has not been
applied. Report it as unknown.

The `Control-plane Worker` check counts invocation **outcomes**, not log lines. "None of them failed inside the Worker"
means no invocation ended in `scriptThrew`, `exceededCpu`, or any other non-benign status in the last 24 hours; it says
nothing about handled errors, logged warnings, or anything a request logged on its way to a 200. The exception text
lives in Workers Logs, which needs an observability grant Wrangler's own OAuth token does not carry
(`detail.logsAvailable` is `false` for exactly that reason), so do not report this check as "no errors in the logs". A
window with no invocations at all is reported as needing attention, because this Worker serves cloudchef.build and fires
a cron every 15 minutes.

The JSON mode carries the same information as `status` (`ok` / `attention` / `unknown` / `error`), `headline`, and a
`checks` array where each entry has `id`, `title`, `status`, `sentence`, `at`, `relative`, and a `detail` object.

Exit status is 0 whenever a report was produced, including an unhealthy one, and 1 when the control plane could not be
read at all - typically because Wrangler is not authenticated. Judge health from `status`/`headline`, not from the exit
code.

## What it is

`scripts/ops-report.mjs`, a plain ESM Node script with no dependencies. It reads production control-plane D1 with
`wrangler d1 execute cloudchef --remote --json` under the operator's existing Cloudflare authentication, and reads the
control-plane Worker's invocations from the Workers analytics GraphQL API with the credential `wrangler auth token`
hands back. Every statement is a `SELECT` and every API call is a read; the tool never writes, deletes, or upgrades
anything, and holds no credential of its own. If Wrangler is authenticated against more than one account, set
`CLOUDFLARE_ACCOUNT_ID` so the Worker read knows which one to ask about.

Runtime staleness is measured against `app/generated/user-workspace-runtime.generated.ts`, the workspace runtime build
of the current checkout. If that generated file is absent the report says staleness is unknown rather than guessing;
`pnpm run generate:artifacts` restores it.

## When it is not the right tool

- Acting on a finding - upgrading a user's runtime, for instance. This tool only reports. Those actions live in the
  control plane under `app/lib/.server/`.
- Deployment or configuration verification. Use `pnpm run verify:production-config`, `pnpm run verify:stack`, or
  `pnpm run validate`.
