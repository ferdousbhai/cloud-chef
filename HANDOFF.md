# Handoff

Kept current and committed; only the plan ahead. The repository is public: no names of people, their projects or
spaces, no billing figures, and no unfixed security weaknesses here.

Production: see `git log`; confirm at `/api/version` after each push.

Goal: making your own software and sharing it is easy. Several people build one project together as easily as they edit
a shared document, and each person has a public page of what they made. Each person keeps their own workspace; the
project's repository in Artifacts is what they share.

Release: branches merge into `next`, `pnpm run validate`, push to `main` (deploys), confirm `/api/version`; runtimes then
upgrade by themselves within about 15 minutes. `pnpm run ops` compares runtimes with this checkout, so it reads "0 of N"
whenever `next` has an unreleased runtime change: use `ops:json`'s per-runtime versions then.

## Next

1. **Try with a second account**, since none of this has run for anyone but the owner:
   - A viewer's workspace (Can view on a team project, and on one shared from another account): Open, a question
     answered, a commit kept after the container sleeps, a branch push refused, `cloudchef suggest`, the preview built
     at once and Try it on the thread, Accept (main moved forward, and a merge commit after main changed), Decline with
     a reason, an offer brought up to date, the role raised to Can edit mid-chat.
   - A read-only `@cloudchef` run (a mention by someone who can't edit).
   - A private project's post as a teammate on a team project: it loads for them and is a 404 for everyone else.
   - Sharing between two accounts: seed, push, publish the owner's site, a viewer's History and Download, a copy.
2. **Managed spaces are withdrawn** (owner, 2026-11-25; `docs/DECISIONS.md`). Removed in `0e342983`, their tables
   dropped in `9d335327`, their payment setup taken down. Left:
   - an emptied space that probably hosted managed spaces still has a runtime: ask the owner whether to delete it in
     Settings;
   - `organizations.managed_host_org_id` stays, fenced by 0075's triggers; 0074's two rollout triggers stay because
     test fixtures still insert the old way (dropping them broke 89 tests).
3. **A collaborator works with what the project already has** (owner, 2026-11-25; `docs/DECISIONS.md`). Shipped in
   `9ddcf51a`: a publish for anyone but the project's creator or an admin of its space uses only what the live
   Worker already uses and makes nothing new; the creator publishes a version that adds something by trying the
   failed publish again. An invite gives no apps of their own unless its box is ticked (`aa7566e2`). Left:
   - not tried live: needs a second account that is a member, or someone a project is shared with, publishing a
     version with a new binding (expect the failed publish to name it), then the creator's Try again. The live
     Worker's settings are read from `/workers/scripts/<name>/settings`, the endpoint and fields Wrangler's own
     provisioning compares (checked in its source); still watch the first real publish by a collaborator;
   - not covered: a project Workers Builds publishes (imported from GitHub) is built by Cloudflare from the
     repository's Wrangler config, so an editor can add a binding there;
   - the public side stays (owner, 2026-11-25): anyone signs up and can look, follow, like and comment; without a
     Cloudflare account or a project they were added to they have no workspace, container or model.

   3a. **One way onto someone else's project** (owner, 2026-11-25; `docs/DECISIONS.md`). Share adds the person to the
   project inside the owner's Cloudflare account (`61759be5`, migration 0078). The owner then decided: no "New
   space", no space invites or `/join`, no "may start apps of their own" (only admins start projects and get the
   account's token), "Make admin" stays as the one higher level. Not tried live. Left to do:
   `organization_members.drafts_allowed` is unread but stays (0074's rollout trigger writes it). The agent is told
   when its person was added to someone else's project (`addedTo`).

   3b. **Spaces are out of sight** (owner, 2026-11-26). No switcher, home is the person's own account, Settings says
   People, cards show who is on a project as faces, and 0081 folded a second space of the owner's into their own.
   Waiting on the owner: deleting the emptied spaces in Settings, People, which removes their workspaces and old chats
   for good. Terms and Privacy still say "space" (their own defined term; a rewrite, not a search and replace). A
   provider's keys are tried named-first then `default`, then Workers AI, remembered per chat for an hour
   (`ef8d9cce`). Not tried: a real refusal of a named key.

4. **Every project publishes with CloudChef** (owner, 2026-11-27). Done: the builder publishes `cf` projects
   (`cf-project-build.ts`: the build's settings converted by Cloudflare's `@cloudflare/config`, deployed by
   CloudChef's Wrangler); the two projects Workers Builds published were moved over (each onto its existing Worker,
   a preview first, then production, both checked live), and their Workers Builds triggers deleted; a new GitHub import is made with
   `deploys_with = 'cloudchef'`. No project has `deploys_with = 'workers_builds'` any more. Left:
   - remove what only Workers Builds projects used, now dead code: the `workers_builds` side of `deploys_with` (the
     column goes in a second release), `workers_builds_script_tag`, the linked-build watch
     (`linked-project-build.ts`), `workers-builds.ts` with the supersede guard, the Workers Builds branch of offered
     previews and of History's publish states, `buildsFromGitHub`, and the `workers-ci` scopes if nothing else needs
     them;
   - not tried: a GitHub import from start to finish on CloudChef's builder. It publishes to a Worker named by its
     config, or to a suffixed name when that Worker exists, with the card's "use that Worker" to take it over;
   - a `cf` project whose build output is newer than `v0`, or that builds several Workers or a container, is refused
     with a reason; previews of a project with `previewUrls: false` upload a version but have no address.

5. **Image check for showcase pictures**, deferred by the owner as issue #154; needed before sign-up is promoted, and
   reports cover it for now. Goes in `classifyMedia`: CloudChef's own Workers AI, a per-person daily cap.

6. **Container cost.** Most of a month's Cloudflare bill was containers held awake at under 1% CPU use; the idle
   stops of `da524030` and `22dcccac` should fix that. Check the billable usage page again after a week of real use.
   Open choice: a custom size with 4 vCPU and less than `standard-4`'s 12 GiB, which would cut what awake time costs;
   not tried, and whether Cloudflare accepts that ratio is unverified. Measured on a laptop, a starter app's checks
   take about 9 s (build 5 s, typecheck 3 s of which `cf-typegen` is 2 s, lint under 1 s since `0977aeb3`), so a
   smaller tier is not justified by faster tools, and running the checks side by side was left out: typecheck
   rewrites the configuration the build reads.

## Not yet tried live

- A clip in a real workspace; the first chat-made app's publish.
- A post page's redirect from an old name: check it the first time a public project is renamed.
- `cf` read and change through the proxy with the real CLI; WebMCP in a real browser.
- "Someone you follow posted" (`announcePost`, from `projectPublished`): watch the first real public post by someone
  with followers; a new account's first-day post is announced only by a later publish.
- A commit whose save failed, saved before the idle stop (`workspace_git_save_failed` in the account's own Workers
  Logs when it can't be).
- CloudChef's long thread replies: the next `@cloudchef` answer over 1,000 characters should show whole.

## Known gaps

- **Offered changes:** a preview is built when the change is offered, from the branch `suggested-<n>`, and uses
  the project's live data, which the owner is fine with (2026-11-19). For a project Workers Builds deploys, Try it
  shows once an editor reads the threads after the build is done. The offer shows its message, not the prompts
  behind it (chats stay in their person's account). The branch is removed on Accept and when the thread is closed on
  the post's page, not when the builder closes it from a chat. The merge is by whole files, so a file both sides
  changed goes back to the person who offered it. A suggestion from a copy has no Accept (its commit is in another
  repository), and only public copies suggest (the owner agreed a private copy may too; not built, since viewers no
  longer need a copy). A project never published has no post, so it can't be offered a change.
- **Browser bundle:** close to the brotli budget in `bundle:check`; the next UI addition may need room made or the
  budget raised (owner's call).
- **Showcase:** not built: "…is now on your page" tip, a warning page before a reported site.
- **Site pictures:** a cookie banner not marked as a dialog still shows.
- **Clips:** the agent isn't told whether the person approved; undecided drafts never expire; `/reports` shows only a
  post's screenshot; the caption box blends into very dark sites; two play buttons on the phone chat card.
- **Sharing:** shared projects missing from the command-line project list.
- **Presence, open choices:** faces on project cards (needs a cheap `GET /api/projects/presence`); "working with
  CloudChef" only while that person's browser is open; "Live" is inferred from the newest successful main build, so a
  dashboard rollback isn't noticed.
- **Workspace:** programs people install don't survive sleeps. Rolling back from `durable_object` needs deleting each
  runtime's two applications after deploying the previous release.
- **Waiting on others** (both checked 2026-11-19): picomatch's advisory GHSA-fc5q-39xc-vjpf is in `ignoreGhsas` in
  both workspaces until a patched release (none yet; 4.0.7 is the latest): drop it then. Pi upstream issue
  earendil-works/pi#11557 (hand off and keep the run going) is open: switch to it when shipped.

## Watch out

- Shares, invitations, `project_shared` notifications, posts, pending copies and `project_slug_redirects` all REFERENCE
  `org_projects`: any rebuild of that table must step them all aside. `'draft'` stays in its `created_from` CHECK until
  then.

## Later

Explore's order favours the people a person follows once there are enough posts that newest-first no longer serves
(owner, 2026-11-26; `docs/DECISIONS.md`, No feed page); search and suggested people after that.

Video beyond clips: a page recording (rrweb, replayed in a locked-down frame) may follow.

Not planned now: templates and a TanStack Start blank project, GitHub mirror, team sign-in for generated apps, app inbox,
health digests, one shared workspace per project.
