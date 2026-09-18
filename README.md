# CloudChef

CloudChef is an AI builder for applications on the Cloudflare developer platform. Its Durable Object workspace and
isolated Cloudflare build runtime work from desktop and mobile browsers, generate Cloudflare-native projects, and
deploy them to the user's own Cloudflare account.

Try it at [cloudchef.build](https://cloudchef.build).

## Requirements

- Node.js 26 or newer
- pnpm 11.14.0, as pinned by `packageManager`
- A Cloudflare account for production deployment

## Setup

```bash
nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm run validate
```

Production provisioning and the Cloudflare Workers Builds deployment path are documented in
[DEVELOPMENT.md](DEVELOPMENT.md).

## Commands

| Command                          | Purpose                                         |
| -------------------------------- | ----------------------------------------------- |
| `pnpm run validate`              | Run the complete repository validation          |
| `pnpm run build`                 | Build the root Worker application               |
| `pnpm run generate:artifacts`    | Rebuild ignored template and runtime bundles    |
| `pnpm run workers-builds:deploy` | Production deploy entrypoint for Workers Builds |
| `pnpm run sbom:production`       | Print a reproducible production SPDX SBOM       |
| `pnpm run ops`                   | Report the operational state of production      |

Use [AGENTS.md](AGENTS.md) as the source index, [ARCHITECTURE.md](ARCHITECTURE.md) for runtime boundaries, and
[DEVELOPMENT.md](DEVELOPMENT.md) for contributor workflows.

## Contributing and Security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report suspected vulnerabilities privately as
described in [SECURITY.md](SECURITY.md).

CloudChef began as a substantially modified derivative of
[Chef](https://github.com/get-convex/chef), which itself was based on
[bolt.diy](https://github.com/stackblitz-labs/bolt.diy). CloudChef is licensed under the
[Apache License 2.0](LICENSE); retained third-party notices are in [NOTICE](NOTICE) and
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
