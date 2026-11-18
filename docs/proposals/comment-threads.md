# Proposal: comment threads in place of issues

Status: proposal. No product code changes with this document. Ships as one release.

## Problem

CloudChef's direction: people make their own apps and share them the way they share photos or writing. A public
project is a post at `/<owner>/<slug>`. Others like it, comment on it and copy it. Software also needs what GitHub
issues give it: someone reports a problem or asks for something, the maker works on it, and the person who asked
hears back. CloudChef should do that with comments, not with an issue tracker. Each top-level comment on a post
starts a thread. The thread works as that post's issue: it is open or done, people who can edit it can ask
the builder agent about it with `@cloudchef`, and when the change goes live the thread says so and the person who started it is told.

What exists today (`migrations/0056_showcase.sql`, `app/lib/cloudflare/data/posts.server.ts`,
`app/components/showcase/Comments.tsx`):

- `post_comments` is a flat list: body (up to 1,000 characters), `status` (`visible`, `held`, `removed`), time. No
  replies, no open/done state, no tie to the version of the app it was written about.
- Commenting needs sign-in and a username, at most 200 a day per person, and comments go through the post report path.
- `post_commented` notifies the post's author.
- `posts.commit_sha` is main's commit that is live now. `org_projects.copied_from` records a copy's source, and
  `posts.copy_count` counts copies.
- The agent already has a command that reaches CloudChef from the workspace container, `cloudchef reel`
  (`user-workspace-runtime/src/reel-proxy.ts`, `app/agents/builder-reels.ts`). It runs only while an agent command is
  running.
- `ProjectRepositories.isAncestor` (`app/lib/.server/cloudflare/project-repository.ts`) answers whether one commit
  is in another's history, in the account that holds the repository.

## The loop

1. A visitor opens a thread on a post: "The date picker doesn't work on my phone." The thread records the commit
   that was live (`posts.commit_sha`). The maker is notified.
2. Others reply under it. Replies are one level deep, as on Instagram. A reply can't start a new thread.
3. Anyone who can edit the project writes a reply that mentions `@cloudchef` and says what to do: "@cloudchef make
   the date picker work on phones and publish it." There is no button: the mention is the request. That starts a run
   of the builder agent on the project, as the person who mentioned it, in the space they build in. Its first message
   is the thread's first comment plus the reply that mentioned it. A later `@cloudchef` reply in the same thread goes
   to the same chat.
4. The agent gets to work. While it runs, the thread shows "CloudChef is working on this" and, for people who can
   edit the project, a link to the chat.
5. When the run ends, the agent's final message is posted in the thread as the reply to the comment that mentioned
   it, shown as "CloudChef, asked by @ferdous". Each mention gets one reply: what was done, or the answer to what
   was asked. A run that fails posts "CloudChef couldn't finish this" with the reason; a run the person stops posts
   nothing.
6. If the change answers the thread, the agent also runs `cloudchef comments done <id>`. The thread becomes **on its
   way** and records main's commit at that moment as its fix commit. When a production publish goes live whose commit
   has the fix commit in its history, the thread becomes **done**, marked "Changed in the update of <date>", and
   everyone in the thread is notified. If the fix commit is already live (`posts.commit_sha` equals it), the thread
   is done at once. If the person asked only for a preview, the agent leaves the thread open and its reply says where
   to try the preview.

Only a turn a mention started posts back. Messages the person types in that chat themselves stay in the chat, as any
chat does; to post again, they mention `@cloudchef` in the thread.

A mention by someone who can't edit the project is ordinary text: it starts nothing and the comment box says nothing
about it. A `@cloudchef` in a thread's first comment, by someone who can edit, starts a run with that comment alone.
`cloudchef` is already a reserved username (`app/lib/usernames.ts`), so the mention can't name a person.

The maker can also mark a thread done by hand, with an optional reply ("Not planning to change this"), with no agent.
The person who started a thread can mark it done too, and can open it again. A new reply on a done thread doesn't
open it again: the person starts a new thread.

## Where the run happens

The run is the asker's: their space, their model and their usage, as if they had opened the project and typed the
message in its chat. The control plane checks that they can edit the project (`canUseConnection` and the project's
edit role), then starts a conversation in the project through the same path the browser uses to open one and send a
first message, without the browser. The chat appears in the project's chat list for them, named after the thread, so
they can follow it, take over, or Stop it. Someone who can edit but has no space yet gets a reply under their own
mention from CloudChef: "Choose where to build first", linking to it, and nothing runs.

Inference and the workspace stay in the asker's account. The control plane stores only what it stores for any
comment: the thread's text, and the chat's id on the thread so later mentions reach it.

## Suggesting a change from a copy

A copy credits its source already. The post page lists a project's public copies under "N copies", each linking to
its post. The maker of a public copy can press **Suggest to @owner** on the original's post. That starts a thread of
kind `suggestion` that names the copy's project and its live commit, with **Try it**, which opens the copy's live
site. Someone who can edit the original takes it with a mention: "@cloudchef bring this in." The run's first message
then also names the copy's public git address (`https://cloudchef.build/<copier>/<slug>.git`) and commit. The agent
fetches it and brings the change in as it sees fit, and replies and closes the thread as in steps 5 and 6. A suggestion needs the
copy to be public, because the original's agent reads its code the way anyone can.

This is a pull request in plain form: the code stays in each person's own account, and the change is made by the
original's agent. Nothing merges across accounts automatically.

## The agent

Following "trust the model": no forced flow, just a command and one line of environment.

- `cloudchef comments`, in the workspace container through a proxy like `reel-proxy.ts` (host `showcase.internal`,
  path `/comments`):
  - `cloudchef comments` lists the project's open and on-its-way threads: id, who, when, the first comment, the
    number of replies, and whether it was written on an earlier version.
  - `cloudchef comments show <id>` shows the whole thread.
  - `cloudchef comments done <id>` marks the thread on its way, as above.
- There is no reply command: the run's final message is the reply. The person asked in public, in that thread, so it
  is posted without approval. Marking done works from an agent command in a chat a mention in that thread started,
  and only on that thread. Reading works from any chat and from the person's own terminal.
- The environment section of the system prompt says how many open threads the project's post has, when it has a
  post, and names the command. In a chat a mention started, it also says which thread, that its final message is
  posted there in public, and the limit of 1,000 characters (`post_comments.body`'s CHECK). A longer final message
  is cut at the limit with "…".

## Data model (control-plane D1)

One migration. `ALTER TABLE … ADD COLUMN` covers `post_comments`. `notifications` is rebuilt for its new kinds,
copying every row in order, as `0059_project_shares.sql` did; nothing references it.

```sql
-- A comment with no parent starts a thread; a reply names its thread. Replies are one level deep.
ALTER TABLE post_comments ADD COLUMN parent_id TEXT REFERENCES post_comments(id) ON DELETE CASCADE;
-- main's commit that was live when it was written (posts.commit_sha then).
ALTER TABLE post_comments ADD COLUMN commit_sha TEXT;
-- Thread starts only (NULL on replies): 'comment' or 'suggestion' (made from a copy, named below).
ALTER TABLE post_comments ADD COLUMN kind TEXT CHECK (kind IN ('comment', 'suggestion'));
-- Thread starts only: 'open', 'on_its_way' (the agent marked it done, waiting for a publish with fix_commit), 'done'.
ALTER TABLE post_comments ADD COLUMN state TEXT CHECK (state IN ('open', 'on_its_way', 'done'));
ALTER TABLE post_comments ADD COLUMN fix_commit TEXT;
ALTER TABLE post_comments ADD COLUMN state_by TEXT REFERENCES "user"(id) ON DELETE SET NULL;
ALTER TABLE post_comments ADD COLUMN state_at INTEGER;
-- Thread starts only: the chat a `@cloudchef` mention started, in the asker's space, and who asked.
ALTER TABLE post_comments ADD COLUMN chat_id TEXT;
ALTER TABLE post_comments ADD COLUMN chat_by TEXT REFERENCES "user"(id) ON DELETE SET NULL;
-- 1 on a reply the agent posted; `author_id` is then the person whose mention started its chat.
ALTER TABLE post_comments ADD COLUMN by_agent INTEGER NOT NULL DEFAULT 0 CHECK (by_agent IN (0, 1));
-- A suggestion's copy and its live commit then.
ALTER TABLE post_comments ADD COLUMN suggested_project_id TEXT REFERENCES org_projects(id) ON DELETE SET NULL;
ALTER TABLE post_comments ADD COLUMN suggested_commit TEXT;
UPDATE post_comments SET kind = 'comment', state = 'open';
CREATE INDEX idx_post_comments_thread ON post_comments(parent_id, created_at);
CREATE INDEX idx_post_comments_state ON post_comments(post_id, state);
```

Every existing comment becomes an open thread. Production has two users, so check its comments first and mark done
by hand any that no longer apply.

Notifications gain `comment_replied` (to the thread's starter and everyone who replied, except the person replying),
`thread_done` (to the same people, with "changed" or "closed" in `detail`) and `change_suggested` (to the original's
author). `post_commented` stays for new threads.

Counts: `posts.comment_count` keeps counting every visible comment. The post shows "N open" from
`idx_post_comments_state`.

## Telling that a fix went live

The repository is in the owner's account, so the check runs there. When a production publish is recorded
(`recordProductionPublish`, called from `app/server-handlers/runtime-deployments.ts` for projects CloudChef deploys
and `app/server-handlers/runtime-projects.ts` for Workers Builds projects), the control plane's answer to the
runtime lists the project's `on_its_way` threads and their fix commits. The runtime checks each one with
`isAncestor(repo, fix_commit, published_commit)` and reports the threads that went live. The control plane then marks
each one done and notifies. If `isAncestor` returns null (history too long to walk), the
thread stays on its way and the maker can mark it done by hand. A rewrite of main (`cloudchef repo rewrite-main`) can
drop a fix commit; the thread then stays on its way, which is true.

## Interface

Plain words throughout (see the language rule for user text): "open", "on its way", "done", "Changed in the update
of Nov 20". No "issue", "commit" or "merge".

- **Post page, comments**: threads, open ones first by newest activity, then on-its-way ones, then done ones collapsed
  to one line each. Each thread shows its replies (the latest three, plus "Show N more"), a reply box, and its state.
  A thread written on an earlier version says "On an earlier version".
- **Thread menu**: Mark done / Open again (maker, starter), Delete (author, maker), Report (others).
- **Reply box**: for people who can edit the project, typing `@` offers `@cloudchef` first, beside the thread's
  people. Nothing else changes for them; no button.
- **"N copies"** beside the like count opens a list of public copies. On the original's post, the maker of a public
  copy sees **Suggest a change** under the comment box.
- **Live app on the post page**: when `site_frameable`, the post shows the live site in a frame, with the screenshot
  as its poster until it loads. This is listed as not built in HANDOFF.md, and it belongs here: the app is the post.
- **Projects home**: a project card shows "N open" when its post has open threads, linking to them.

## Moderation and limits

Replies and suggestions are comments. They go through the same body checks, daily limit and reports, and a held
thread start hides its replies. Deleting a thread start deletes its replies (`ON DELETE CASCADE`). Thread state
changes need no new limit, since only the maker and starter can make them. Mentions need none either: only people
who can edit the project start runs, in their own space, and their comments already count toward the daily limit.
The agent's replies don't count toward the asker's limit.

## Code that changes

- `migrations/0063_comment_threads.sql`.
- `app/lib/cloudflare/data/posts.server.ts`: threads, replies, state, suggestions, copies list. `PostComment` in its
  types gains the new fields.
- `app/server-handlers/showcase.ts`: routes for replies, state, suggestions, copies, and the agent's `/comments` calls.
- `app/lib/.server/showcase/jobs.ts` and the two publish handlers above: waiting fixes in the publish answer, then
  posting and notifying.
- `user-workspace-runtime/src/comments-proxy.ts` (new, like `reel-proxy.ts`), `container-toolchain.ts` (the
  `cloudchef comments` command), and the runtime's publish reporting (`isAncestor` on the waiting fixes). This is a
  runtime change, so run `pnpm run generate:artifacts`.
- `app/server-handlers/showcase.ts` and `app/agents/conversation-agent.ts`: a mention starts a conversation in the
  asker's space without the browser, and the end of a turn a mention started posts its final message to the thread;
  environment lines in the system prompt.
- `app/components/showcase/Comments.tsx`, `PostPage.tsx`, `PostActions.tsx`, `PostMedia.tsx` (live frame),
  `Notifications.client.tsx`; the project card; a new `CopiesDialog.tsx`; starting a project chat with a first
  message.
- CLAUDE.md code index; `app/routes/privacy.tsx` if it describes comments.

## Release

One release: migration, control plane, runtime and interface together. Nothing is dropped, so no second release is
needed. Runtimes pick up the new command in their next upgrade window. Until a runtime upgrades, the post page's
thread features all work; only `cloudchef comments` and the live-fix check wait for it, and on-its-way threads
resolve on the first publish after the upgrade.

## Decisions for the owner

| Decision                                | Recommendation                                   | Alternative                                                      |
| --------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| Who can open a thread                   | Signed in with a username, as comments are today | Anyone, which needs a captcha and more moderation                |
| Who marks a thread done                 | The maker (anyone who can edit) and the starter  | The maker only                                                   |
| Done threads                            | Collapsed at the bottom, still public            | Hidden behind "Show done"                                        |
| Does the agent see open threads unasked | One environment line; it decides                 | Only in a chat a mention started                                 |
| Who can mention `@cloudchef`            | People who can edit the project                  | Anyone, with the run in the maker's space, which spends theirs   |
| A separate "won't change" state         | No: done with a reply says it                    | A third final state, `declined`                                  |
| Suggestions from private copies         | Not offered                                      | Offered with a one-time read token (`readAccess`), more to build |

## Risks

- **Public pressure on makers**: a busy post's open count can feel like a bug list. Done threads collapse, and the
  starter can close their own thread.
- **The agent speaks in public for the asker**: its final message goes out without review. It is labelled as
  CloudChef's, names who asked, and the asker can delete it like any reply on their project. The environment tells
  the agent the message is public.
- **A mention spends the asker's usage**, sometimes without them watching. The chat is in their list to follow or
  Stop, and only people who can edit can start one.
- **Suggestions bring in code from a stranger's project**: the original's agent reads and adapts it in the original's
  own workspace and account. It never runs on CloudChef, and the maker sees the result before it goes live, as with
  any chat change.
