---
name: cloudchef
description: Work on CloudChef (cloudchef.build) projects from this computer with the `cloudchef` command - list, clone and copy projects, make one public or private, publish changes by pushing to main, preview a branch, wait for a publish to finish, and read a publish log to fix a failed one. Use when the user mentions CloudChef or cloudchef.build, or when the current git repository has a remote on a CloudChef host, such as https://cloudchef.build/ferdous/alberta-plan-glossary.git.
---

# CloudChef

CloudChef keeps each project as a git repository and publishes it to the project owner's Cloudflare account. The
`cloudchef` command works with CloudChef the way `gh` works with GitHub. Run `cloudchef help` for every command.

## Projects are git repositories

- A project is named `owner/name`, like `ferdous/alberta-plan-glossary`, and its git address is
  `https://cloudchef.build/ferdous/alberta-plan-glossary.git`.
- `cloudchef repo list` lists the projects you can use: name, account, your role (view or edit), whether it is public
  or private, last publish, site.
- `cloudchef repo clone ferdous/alberta-plan-glossary` clones one into `~/cloudflare/ferdous/alberta-plan-glossary`
  (change the folder with `cloudchef config set clone-dir PATH`, or pass a folder as the second argument). Just the
  name works too when only one of your projects has it.
- Git signs in through `cloudchef` (set up by `cloudchef auth login`), so plain `git pull` and `git push` work.
- Pushing to `main` publishes the project to its live site.
- Pushing any other branch builds a preview of that branch and leaves the live site alone.
- With the view role you can clone and pull but not push.
- A push only adds to `main`'s history: one that would rewrite it is refused (`git pull`, then push again). When the
  project's owner means to rewrite it (to drop large files from old commits, say), push the rewritten history to a
  branch, then run `cloudchef repo rewrite-main BRANCH`: main becomes that branch's history and publishes. Only the
  owner (for a team's project, one of its admins) can; it asks to type the project's name, or needs
  `--accept-history-rewrite` when not run in a terminal, so ask the user before passing it. Every other copy of the
  project must then be cloned again or reset to the new main.
- `cloudchef repo create NAME --push`, run in a git repository, makes a new project from it with its whole history:
  it adds the git remote `cloudchef` and pushes the current commit to the project's `main`, which publishes it (then
  `cloudchef run watch`). Without `--push` the project stays empty until `git push -u cloudchef HEAD:main`.
  `--remote NAME` names the remote, `--account ACCOUNT` picks the account, `--source DIR` another folder. A folder
  that isn't a git repository (or has no commits) is uploaded as files instead, and publishes by itself.

## Public projects

- A public project can be found, read and copied by anyone signed in to CloudChef. Only people with the edit role on it can push.
- `cloudchef repo list --public` lists everyone's public projects. `cloudchef repo view OWNER/NAME` and
  `cloudchef repo clone OWNER/NAME` work for them too (read only: clone and pull, no push).
- `cloudchef repo fork OWNER/NAME` copies a project, with its history, into a new project of your own and prints its
  name; `--name NAME` names the copy, `--account ACCOUNT` picks the account (default Personal), and `--clone` clones the
  copy with the original as the git remote `upstream`. Copying can take a minute. Change and push the copy, not the
  original.
- `cloudchef repo edit OWNER/NAME --visibility public` makes a project public and `--visibility private` makes it
  private again. Making one public needs `--accept-visibility-change-consequences`; ask the user before passing it,
  since everyone signed in can then read and copy the code.

## After a push

1. `cloudchef run watch` waits for the publish of what you pushed. It exits 0 when the publish succeeded and 1 when it
   failed. When it succeeds it prints where to see it: `Live at` the site for `main`, `Preview at` the preview's
   address for any other branch. `cloudchef run view` shows the same address as `url:`.
2. When it failed, `cloudchef run view --log` prints the publish log. Find the error, fix it, commit, push, and watch
   again.
3. `cloudchef run rerun` publishes the same commit again, for failures the code didn't cause (a timeout, a service
   outage).
4. `cloudchef browse` opens the live site, or, on a branch other than `main`, that branch's preview.

Run these inside the clone. Elsewhere, name the project: `cloudchef run watch --project ferdous/alberta-plan-glossary`.

## Secrets

- API keys and other secrets belong in Cloudflare (the project's Worker secrets), never in files in the repository.
- `.env` and `.dev.vars` files aren't pushed; keep them listed in `.gitignore`.
- Never print, log, commit, or paste the CloudChef token (`cloudchef auth token`, `~/.config/cloudchef/token`, or
  `CLOUDCHEF_TOKEN`). Git gets it from `cloudchef` by itself.
