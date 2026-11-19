# Proposal: comment threads in place of issues

Status: proposal, decisions settled by the owner (2026-11-18). No product code changes with this document. Ships as
one release.

## Problem

CloudChef's direction: people make their own apps and share them the way they share photos or writing. A public
project is a post at `/<owner>/<slug>`. Others like it, comment on it and copy it. Software also needs what GitHub
issues give it: someone reports a problem or asks for something, the maker works on it, and the person who asked
hears back. CloudChef adopts GitHub's issue model, adapted to comments: each top-level comment on a post starts a
thread, and the thread is that post's issue. It has a number, it is open or closed with a reason, people follow it,
and anyone can ask the builder agent about it by mentioning `@cloudchef`.

What exists today (`migrations/0056_showcase.sql`, `app/lib/cloudflare/data/posts.server.ts`,
`app/components/showcase/Comments.tsx`):

- `post_comments` is a flat list: body (up to 1,000 characters), `status` (`visible`, `held`, `removed`), time. No
  replies, no state, no tie to the version of the app it was written about.
- Commenting needs sign-in and a username, at most 200 a day per person, and comments go through the post report path.
- `post_commented` notifies the post's author.
- `posts.commit_sha` is main's commit that is live now. `org_projects.copied_from` records a copy's source, and
  `posts.copy_count` counts copies.
- The agent already has a command that reaches CloudChef from the workspace container, `cloudchef reel`
  (`user-workspace-runtime/src/reel-proxy.ts`, `app/agents/builder-reels.ts`). It runs only while an agent command is
  running.
- `ProjectRepositories.isAncestor` (`app/lib/.server/cloudflare/project-repository.ts`) answers whether one commit
  is in another's history, in the account that holds the repository.
- `cloudchef` is already a reserved username (`app/lib/usernames.ts`), so `@cloudchef` can't name a person.

## From GitHub issues to threads

| GitHub issues                | CloudChef threads                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| Issue, with a number         | A top-level comment on a post starts a thread, numbered per post: #1, #2, …         |
| Issue comments               | Replies, one level deep under the thread's first comment                            |
| Open / closed                | Open, on its way (a change is made and waiting to go live), closed                  |
| Closed as completed          | Closed as changed: "Changed in the update of Nov 20", set when the change goes live |
| Closed as not planned        | Closed as not planned                                                               |
| Closed as duplicate          | Closed as the same as #n, linking to it                                             |
| Reopen                       | Open again                                                                          |
| `#123` references            | `#3` in a comment links to thread 3 on the same post                                |
| `@user` mentions             | `@username` notifies that person and makes them follow the thread                   |
| Subscribe / unsubscribe      | Follow / Mute a thread                                                              |
| Lock conversation            | Lock: only people who can edit the project can reply                                |
| Pinned issues                | Pin: up to three threads at the top of the post                                     |
| Pull request                 | A suggestion from a public copy (below)                                             |
| Copilot assigned to an issue | `@cloudchef` in a thread                                                            |

Left out: labels, assignees and milestones. They sort many issues among many people; a post has one maker or a small
team, and its threads fit on one page. Any of them can be added later as a column on thread starts.

## The thread

1. A signed-in person with a username opens a thread on a post: "The date picker doesn't work on my phone." The thread
   gets the post's next number and records the commit that was live (`posts.commit_sha`). The maker is notified, and
   the starter follows it.
2. Others reply under it. Replies are one level deep, as on Instagram. Replying, or being mentioned, follows the
   thread. Anyone signed in can Follow a thread, and anyone following it can Mute it.
3. Anyone who can edit the project, and the person who started the thread, can close it as **changed**, **not
   planned** or **the same as #n**, and open it again. A new reply on a closed thread doesn't open it again.
4. People who can edit the project can lock a thread and pin up to three.

Closed threads stay public, collapsed to one line each under the open ones, with their reason ("Changed in the update
of Nov 20", "Not planned", "Same as #3").

## Asking CloudChef: `@cloudchef`

Anyone signed in can mention `@cloudchef` in a thread, in its first comment or in a reply: "@cloudchef make the date
picker work on phones and publish it", or "@cloudchef how does this store my list?". The mention is the request; there
is no button.

- **Whose run it is.** The run is the asker's, always: their space, their model and their usage, in their own
  Cloudflare account, as if they had typed the message in a chat. Nobody spends anyone else's account.
- **What it can do.** Someone who can edit the project gets a full run: the agent can read, change and publish the
  project, and close the thread. Anyone else gets a read-only run: the agent reads the project's code and the live
  site and answers, but can't change the project, publish it, or close the thread. Threads exist only on public
  posts, so the code is readable by anyone at its git address.
- **What it is given.** The thread's first comment, plus the comment that mentioned it. It reads the rest with
  `cloudchef comments show`.
- **While it works**, the thread shows "CloudChef is working on this", with a link to the chat for the asker.
- **Its answer.** When the run ends, the agent's final message is posted in the thread as the reply to the comment
  that mentioned it, shown as "CloudChef, asked by @ferdous", without review: the asker asked in public. A run that
  fails posts "CloudChef couldn't finish this" with the reason; a run the asker stops posts nothing.
- **Later mentions** by the same person in the same thread go to the same chat. Messages the asker types in that chat
  themselves stay in the chat, as in any chat; only a turn a mention started posts to the thread.
- **No space yet.** Someone with nowhere to build gets a reply under their mention: "Choose where to build first",
  linking to it, and nothing runs.

### Where the run happens

The control plane receives the comment, finds the asker's connection (the space they build in) and checks what they
may do with the project: edit (the project's members and shares with Can edit, through `canUseConnection` and the
project's roles) or not. It then starts a conversation without the browser, through the same path the browser uses to
open a chat and send a first message:

- **Can edit**: a chat in the project itself, as when they open it (for a shared project, from the collaborator's own
  account, as `handleSharedProjectRequest` already does). The chat appears in the project's chat list, named after
  the thread.
- **Read-only**: a chat in a workspace in the asker's space seeded from the post's public git address at its live
  commit, with no remote to push to. No project is created in their list; the chat appears under "Questions", named
  after the thread. The agent can run the code in its own container, as anyone who clones it can.

Inference and the workspace stay in the asker's account. The control plane stores only the thread's text and, in
`thread_runs`, each asker's chat id, so their later mentions reach it.

### When a change goes live

When the agent's change answers the thread, it runs `cloudchef comments close <n> --changed`. The thread becomes **on
its way** and records main's commit at that moment as its fix commit. If the person asked only for a preview, the
agent leaves the thread open and its reply says where to try it.

The repository is in the owner's account, so the check runs there. When a production publish is recorded
(`recordProductionPublish`, called from `app/server-handlers/runtime-deployments.ts` for projects CloudChef deploys
and `app/server-handlers/runtime-projects.ts` for Workers Builds projects), the control plane's answer to the runtime
lists the project's on-its-way threads and their fix commits. The runtime checks each with
`isAncestor(repo, fix_commit, published_commit)` and reports the ones that went live. The control plane closes each
as changed, with that publish's date, and notifies its followers. If the fix commit is already live when the agent
closes the thread (`posts.commit_sha` equals it), the thread closes at once. If `isAncestor` returns null (history
too long to walk), the thread stays on its way and an editor can close it by hand. A rewrite of main
(`cloudchef repo rewrite-main`) can drop a fix commit; the thread then stays on its way, which is true.

## Suggesting a change from a copy

A copy credits its source already. The post page lists a project's public copies under "N copies", each linking to
its post. The maker of a public copy can press **Suggest a change** on the original's post. That starts a thread of
kind `suggestion`, naming the copy and its live commit, with **Try it**, which opens the copy's live site. Someone
who can edit the original takes it with a mention: "@cloudchef bring this in." The run is also given the copy's
public git address (`https://cloudchef.build/<copier>/<slug>.git`) and commit. The agent fetches it, brings the
change in as it sees fit, replies, and closes the thread as above. Only public copies can suggest, because the
original's agent reads the copy's code the way anyone can.

This is a pull request in plain form: the code stays in each person's own account, and the change is made by the
original's agent. Nothing merges across accounts automatically.

## Offering a change made on the project

Someone who may view a project but not edit it (the view role, on a team project or one shared with them) opens it in
a workspace of their own like anyone else. Git there fetches as usual. A push sets only the workspace's saved branches
(`refs/cloudchef/workspaces/<workspace>/…` in the project's repository, which only that workspace reads or writes), so
their commits are kept, and every push of a branch or tag is refused. As on GitHub, where a pull request's commits
sit under `refs/pull/` of the repository it is offered to, no copy of the project is needed.

`cloudchef suggest "<message>"` in that workspace offers the commit checked out. It keeps the commit on a saved branch
of its own (`suggested/<commit>`), then asks CloudChef (`runtime-projects/suggest`), which starts a suggestion thread
on the project's post whose `suggested_project_id` is the project itself and whose `suggested_commit` is the commit.
The person's offer that is still open takes a new commit instead, with the message as a reply, as a pull request takes
a push. A project with no post yet has nowhere to offer a change.

The code is the project's compiled output: what the people deciding read is the offer's message, and what they try
is a preview of the change. A preview runs the offered code as a version of the project's own Worker, with its
database and storage, so none is built when a change is offered. It is built when someone who can edit the project
looks at the offer (the first step of Accept): a runtime in the project's account puts the commit on a branch of its
own, `suggested-<thread number>` (`preview`), which is built as any pushed branch is. For a project CloudChef deploys
itself the thread then shows **Try it**, the preview's address (`project_deployments`); a project Workers Builds
deploys gets its preview there, not yet linked from the thread. The branch is deleted once the change is accepted.

On the thread, someone who can edit the project sees **Accept** and **Decline**:

- **Accept** first has the preview built and says whether it is ready to try, and lists, as detail, the files the
  commit changes since it and main last shared a commit (`changes`, read in the project's account). **Accept and publish** then has a runtime in the project's account bring the commit into main
  (`mergeIntoMain`): main moves to it when main hasn't changed since, and otherwise takes a merge commit in the
  accepter's name with both as parents. The merge is by whole files; when both sides changed the same file nothing is
  written, and the accepter is told to ask for the change to be brought up to date and offered again. Main is
  published as any push of it is, the push is recorded as the accepter's, and the thread is on its way until that
  version is live.
- **Decline** closes the thread as not planned, with the reason, if one is given, as a reply.

A suggestion from a copy keeps the path above: it has no Accept, since its commit is in another repository.

## The agent

Following "trust the model": no forced flow, just a command and a few lines of environment.

- `cloudchef comments`, in the workspace container through a proxy like `reel-proxy.ts` (host `showcase.internal`,
  path `/comments`):
  - `cloudchef comments` lists the post's open and on-its-way threads: number, who, when, the first comment, the
    number of replies, and whether it was written on an earlier version.
  - `cloudchef comments show <n>` shows the whole thread.
  - `cloudchef comments close <n> --changed | --not-planned | --same-as <m>` closes it, as above.
- There is no reply command: a mention-started run's final message is its reply. Closing works only from an agent
  command in a full run that a mention in that thread started, and only on that thread. Reading works from any chat
  and from the person's own terminal.
- The environment section of the system prompt says how many open threads the project's post has, when it has one,
  and names the command; the agent decides whether to look. In a mention-started chat it also says which thread,
  whether the run is read-only, that its final message is posted there in public, and that it must fit in 1,000
  characters (`post_comments.body`'s CHECK). A longer final message is cut at the limit with "…".

## Data model (control-plane D1)

One migration. `ALTER TABLE … ADD COLUMN` covers `post_comments`, and one new table holds follows of threads.
`notifications` is rebuilt for its new kinds and a `comment_id` column, copying every row in order, as
`0059_project_shares.sql` did; nothing references it.

```sql
-- A comment with no parent starts a thread; a reply names its thread. Replies are one level deep.
ALTER TABLE post_comments ADD COLUMN parent_id TEXT REFERENCES post_comments(id) ON DELETE CASCADE;
-- main's commit that was live when it was written (posts.commit_sha then).
ALTER TABLE post_comments ADD COLUMN commit_sha TEXT;
-- 1 on a reply the agent posted; `author_id` is then the person whose mention started its run.
ALTER TABLE post_comments ADD COLUMN by_agent INTEGER NOT NULL DEFAULT 0 CHECK (by_agent IN (0, 1));

-- The rest are set on thread starts only, NULL on replies.
-- Its number on the post: 1, 2, … in the order threads were started.
ALTER TABLE post_comments ADD COLUMN number INTEGER;
-- 'comment', or 'suggestion' (made from a copy, named below).
ALTER TABLE post_comments ADD COLUMN kind TEXT CHECK (kind IN ('comment', 'suggestion'));
-- 'open'; 'on_its_way' (closed as changed by the agent, waiting for a publish with fix_commit); 'closed'.
ALTER TABLE post_comments ADD COLUMN state TEXT CHECK (state IN ('open', 'on_its_way', 'closed'));
-- Why it was closed: 'changed', 'not_planned', or 'duplicate' (of `duplicate_of`).
ALTER TABLE post_comments ADD COLUMN close_reason TEXT CHECK (close_reason IN ('changed', 'not_planned', 'duplicate'));
ALTER TABLE post_comments ADD COLUMN duplicate_of TEXT REFERENCES post_comments(id) ON DELETE SET NULL;
ALTER TABLE post_comments ADD COLUMN fix_commit TEXT;
ALTER TABLE post_comments ADD COLUMN state_by TEXT REFERENCES "user"(id) ON DELETE SET NULL;
ALTER TABLE post_comments ADD COLUMN state_at INTEGER;
ALTER TABLE post_comments ADD COLUMN locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1));
-- When it was pinned; at most three pinned threads per post, checked when pinning.
ALTER TABLE post_comments ADD COLUMN pinned_at INTEGER;
-- A suggestion's copy and its live commit then.
ALTER TABLE post_comments ADD COLUMN suggested_project_id TEXT REFERENCES org_projects(id) ON DELETE SET NULL;
ALTER TABLE post_comments ADD COLUMN suggested_commit TEXT;

-- Every existing comment becomes an open thread, numbered in the order it was written.
UPDATE post_comments SET kind = 'comment', state = 'open', number = (
  SELECT COUNT(*) FROM post_comments AS earlier
  WHERE earlier.post_id = post_comments.post_id
    AND (earlier.created_at < post_comments.created_at
      OR (earlier.created_at = post_comments.created_at AND earlier.rowid <= post_comments.rowid))
);
CREATE UNIQUE INDEX idx_post_comments_number ON post_comments(post_id, number) WHERE number IS NOT NULL;
CREATE INDEX idx_post_comments_thread ON post_comments(parent_id, created_at);
CREATE INDEX idx_post_comments_state ON post_comments(post_id, state);

-- Who follows a thread: its starter, everyone who replied or was mentioned, and anyone who pressed Follow.
-- `muted` = 1 after Mute, so replying again doesn't follow it again.
CREATE TABLE thread_followers (
  thread_id TEXT NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX idx_thread_followers_user ON thread_followers(user_id);

-- Mention runs: one chat per person per thread, in that person's space.
CREATE TABLE thread_runs (
  thread_id TEXT NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  -- 'edit' (can change and publish the project) or 'read' (read-only), decided when the run starts.
  access TEXT NOT NULL CHECK (access IN ('edit', 'read')),
  -- The comment whose mention the running turn answers; NULL when no turn is running.
  answering_id TEXT REFERENCES post_comments(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
```

Existing threads' followers are filled in by the migration: each comment's author and its post's author.

Notifications gain `comment_id` (the thread or reply the notification is about) and the kinds `comment_replied`
(followers, except the person replying), `comment_mentioned` (an `@username`), `thread_closed` (followers, with the
reason in `detail`) and `change_suggested` (the original's author). `post_commented` stays for new threads. Each person
gets at most one notification per comment.

Counts: `posts.comment_count` keeps counting every visible comment. The post shows "N open" from
`idx_post_comments_state`. Access is checked again at every turn a mention starts: someone who lost edit access gets
a read-only run.

## Interface

Plain words throughout (see the language rule for user text): "open", "on its way", "closed", "Changed in the update
of Nov 20", "Not planned", "Same as #3". No "issue", "commit" or "merge".

- **Post page, comments**: pinned threads, then open ones by newest activity, then on-its-way ones, then closed ones
  collapsed to one line each. Each thread shows its number, state, replies (the latest three, plus "Show N more")
  and a reply box. A thread written on an earlier version says "On an earlier version". `#3` and `@username` are
  links.
- **Thread menu**: Close as changed / not planned / the same as… and Open again (editors, starter); Lock, Pin
  (editors); Follow / Mute (anyone signed in); Delete (author, editors); Report (others).
- **Comment box**: typing `@` offers `@cloudchef` first, then the thread's people. Typing `#` offers the post's
  threads.
- **"N copies"** beside the like count opens a list of public copies. On the original's post, the maker of a public
  copy sees **Suggest a change** under the comment box.
- **Live app on the post page**: when `site_frameable`, the post shows the live site in a frame, with the screenshot
  as its poster until it loads. This is listed as not built in HANDOFF.md, and it belongs here: the app is the post.
- **Projects home**: a project card shows "N open" when its post has open threads, linking to them.
- **Chats**: mention-started chats are named after their thread and link back to it; read-only ones are listed under
  "Questions".

## Moderation and limits

Replies, mentions and suggestions are comments. They go through the same body checks, daily limit and reports, and a
held thread start hides its replies. Deleting a thread start deletes its replies (`ON DELETE CASCADE`). The agent's
replies don't count toward the asker's daily limit, and are reported and removed like any comment. A person can have
at most one running mention turn per thread; a mention while one runs waits for it. Mentions of people go through the
same daily comment limit, so they can't be used to flood someone's notifications.

## Code that changes

- `migrations/0063_comment_threads.sql`.
- `app/lib/cloudflare/data/posts.server.ts`: threads, numbers, replies, state, follows, mentions, lock and pin,
  suggestions, copies list. `PostComment` in its types gains the new fields.
- `app/server-handlers/showcase.ts`: routes for the above, and the agent's `/comments` calls.
- Starting a mention run: from `showcase.ts`, a conversation in the asker's space without the browser, full or
  read-only (`app/agents/conversation-agent.ts`, and seeding a workspace from a public git address without a project
  for read-only runs); the end of a turn a mention started posts its final message to the thread; environment lines
  in the system prompt.
- `app/lib/.server/showcase/jobs.ts` and the two publish handlers above: waiting fixes in the publish answer, then
  closing and notifying.
- `user-workspace-runtime/src/comments-proxy.ts` (new, like `reel-proxy.ts`), `container-toolchain.ts` (the
  `cloudchef comments` command), and the runtime's publish reporting (`isAncestor` on the waiting fixes). This is a
  runtime change, so run `pnpm run generate:artifacts`.
- `app/components/showcase/Comments.tsx`, `PostPage.tsx`, `PostActions.tsx`, `PostMedia.tsx` (live frame),
  `Notifications.client.tsx`; the project card; a new `CopiesDialog.tsx`; the chat list.
- CLAUDE.md code index; `app/routes/privacy.tsx` and `terms.tsx` (CloudChef posts the agent's answer publicly for the
  person who asked).

## Release

One release: migration, control plane, runtime and interface together. Nothing is dropped, so no second release is
needed. Runtimes pick up the new command in their next upgrade window. Until a runtime upgrades, the post page's
thread features all work; only `cloudchef comments` and the live-change check wait for it, and on-its-way threads
close on the first publish after the upgrade.

## Settled by the owner (2026-11-18)

1. Anyone signed in with a username can open a thread, as with comments today.
2. People who can edit the project and the thread's starter can close it and open it again.
3. Closed threads stay public, collapsed at the bottom.
4. The agent is told, in every chat, how many open threads the project's post has, and decides whether to look.
5. Anyone signed in can mention `@cloudchef`. The run is always the asker's, in their own account. Only people who can
   edit the project get a full run; everyone else gets a read-only one.
6. "Not planned" is its own closed reason, apart from "changed". With GitHub's model adopted, so is "same as #n".
7. Only public copies can suggest a change.
8. The agent's reply fits in 1,000 characters; it is told so, and anything longer is cut.
9. Only turns a mention started post to the thread; typing in the chat stays in the chat.
10. Adopt GitHub's issue model, adapted to threads (the table above).

## Risks

- **Public pressure on makers**: a busy post's open count can feel like a bug list. Closed threads collapse, "not
  planned" says no plainly, and the starter can close their own thread.
- **The agent speaks in public for the asker**: its final message goes out without review. It is labelled as
  CloudChef's, names who asked, and is reported and removed like any comment. The environment tells the agent the
  message is public.
- **A read-only run on someone else's app**: it runs in the asker's account, on code anyone can already clone, and
  can't change the project. What it says about the app is public, labelled with who asked.
- **A mention spends the asker's usage**, sometimes without them watching. The chat is in their list to follow or
  Stop.
- **Suggestions bring in code from a stranger's project**: the original's agent reads and adapts it in the original's
  own workspace and account. It never runs on CloudChef, and the maker sees the result before it goes live, as with
  any chat change.
