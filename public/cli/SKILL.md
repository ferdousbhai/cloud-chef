---
name: cloudchef
description: Work on CloudChef (cloudchef.build) projects from this computer with the `cloudchef` command - list and clone projects, publish changes by pushing to main, preview a branch, wait for a publish to finish, and read a publish log to fix a failed one. Use when the user mentions CloudChef or cloudchef.build, or when the current git repository has a remote ending in /git/<project id>.git on a CloudChef host.
---

# CloudChef

CloudChef keeps each project as a git repository and publishes it to the project owner's Cloudflare account. The
`cloudchef` command works with CloudChef the way `gh` works with GitHub. Run `cloudchef help` for every command.

## Projects are git repositories

- `cloudchef repo list` lists the projects you can use: name, account, your role (view or edit), last publish, site.
- `cloudchef repo clone NAME` clones one into `~/cloudflare/<account>/<project>` (change the folder with
  `cloudchef config set clone-dir PATH`, or pass a folder as the second argument). Use `ACCOUNT/NAME` when two
  accounts have a project with the same name.
- Git signs in through `cloudchef` (set up by `cloudchef auth login`), so plain `git pull` and `git push` work.
- Pushing to `main` publishes the project to its live site.
- Pushing any other branch builds a preview of that branch and leaves the live site alone.
- With the view role you can clone and pull but not push.
- `cloudchef repo create NAME` uploads the committed files of the current folder as a new project. The project starts
  with a fresh history; `git pull cloudchef main --allow-unrelated-histories` joins it to your local one.

## After a push

1. `cloudchef run watch` waits for the publish of what you pushed. It exits 0 when the publish succeeded and 1 when it
   failed.
2. When it failed, `cloudchef run view --log` prints the publish log. Find the error, fix it, commit, push, and watch
   again.
3. `cloudchef run rerun` publishes the same commit again, for failures the code didn't cause (a timeout, a service
   outage).
4. `cloudchef browse` opens the live site.

Run these inside the clone. Elsewhere, name the project: `cloudchef run watch NAME`.

## Secrets

- API keys and other secrets belong in Cloudflare (the project's Worker secrets), never in files in the repository.
- `.env` and `.dev.vars` files aren't pushed; keep them listed in `.gitignore`.
- Never print, log, commit, or paste the CloudChef token (`cloudchef auth token`, `~/.config/cloudchef/token`, or
  `CLOUDCHEF_TOKEN`). Git gets it from `cloudchef` by itself.
