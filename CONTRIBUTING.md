# Contributing

Thank you for improving CloudChef. By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

Follow [DEVELOPMENT.md](DEVELOPMENT.md) for setup, configuration, generated artifacts, and deployment.

## Changes

- Follow the boundaries in [ARCHITECTURE.md](ARCHITECTURE.md) and the source-specific instructions in
  [AGENTS.md](AGENTS.md).
- Add focused tests for behavior changes.
- Treat user input, generated files, feedback, repository context, and model output as untrusted.
- Keep secrets out of source and local environment files.

## Verification

```bash
pnpm run validate
```

If a check cannot run, state which checks ran and why the remainder could not.

Report vulnerabilities according to [SECURITY.md](SECURITY.md), not in a public issue.
