# Proposal: showcase pages and the feed

Status: proposal (wave 1, item 4). Builds in wave 2, item 3. No product code changes with this document.

## Problem

Each person gets a page at their username showing what they made: for each project, its live site, a screenshot or a
short video, and a caption, viewed like a picture post. People follow each other and see new work from the people
they follow in a feed. A post leads to the live site and to "Make a copy".

What exists to build on:

- Usernames and project names in addresses, `<username>/<slug>` (`migrations/0044_usernames_and_project_names.sql`,
  `app/lib/usernames.ts`).
- Public projects and copies: `org_projects.visibility`, `copied_from`, Explore for signed-in people
  (`migrations/0045_public_projects_and_copies.sql`, `app/routes/explore.tsx`,
  `app/components/projects/Explore.client.tsx`, `listPublicProjects` and `setProjectVisibility` in
  `app/lib/cloudflare/data/org-projects.server.ts`, `POST /api/projects/copy`).
- The live site's address (`org_projects.site_url`, `site_frameable`) and a live scaled frame of it
  (`app/components/projects/SiteThumbnail.client.tsx`).
- Who published: `project_main_pushes` (`migrations/0052_main_pushes.sql`) and the Workers Builds status the control
  plane reads (`app/lib/.server/cloudflare/workers-builds.ts`, `/runtime-projects/status`).

## Settled by the owner

1. Showcase pages and posts are public on the web: no sign-in to view. Following, liking and the feed need sign-in.
   Reporting and takedown therefore ship in the first release.
2. Screenshots and videos are stored in CloudChef's own storage (an R2 bucket bound to the control plane), with the
   account-boundary invariant amended for showcase media only (wording below).
3. Publishing a public project posts it to the author's page automatically. Private projects never post.

## Dependency

Posts reference `org_projects` only. CloudChef apps made in a chat are still in their own `apps` table
(`migrations/0046_apps.sql`) until wave 2, item 1 makes every project an `org_projects` row with one publish path.
Showcase builds after that item, so it has one kind of project and one "publish succeeded" event.

## The amended invariant

After the managed-spaces amendment (`managed-spaces.md`), add:

> Exception, showcase media only: a screenshot or short video of a public project's live site, taken or uploaded when
> it is posted, is stored in CloudChef's own R2 and served by CloudChef, and the screenshot is taken by Browser
> Rendering in CloudChef's own account, which loads the site's public address as any visitor would. No project code,
> data, chat or build output is stored or run there. Removing a post, making its project private, or erasing the
> author's account deletes its media.

## Data model (control-plane D1)

One post per project. A project's later publishes update its post rather than adding new ones, which is what keeps
automatic posting from being noisy.

```sql
-- A project shown on its author's page and in followers' feeds. One per project; later publishes update it.
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES org_projects(id) ON DELETE CASCADE,
  -- Whose page it is on: the person whose publish made it (see Team projects).
  author_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  -- What it shows: main's commit that was published, and the site address at that time.
  commit_sha TEXT NOT NULL,
  site_url TEXT NOT NULL,
  caption TEXT CHECK (length(caption) <= 2000),
  -- 'visible'; 'hidden' by its author or because the project went private; 'removed' by moderation.
  status TEXT NOT NULL CHECK (status IN ('visible', 'hidden', 'removed')),
  hidden_reason TEXT CHECK (hidden_reason IN ('author', 'project_private', 'author_paused')),
  -- Where it sorts in feeds and on the page: moved by a publish at most once a day, and by a new video or caption.
  shown_at INTEGER NOT NULL,
  published_count INTEGER NOT NULL DEFAULT 1,
  like_count INTEGER NOT NULL DEFAULT 0,
  copy_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_posts_author ON posts(author_id, status, shown_at DESC);
CREATE INDEX idx_posts_shown ON posts(status, shown_at DESC);

-- The pictures and videos of a post, in R2. The newest automatic screenshot replaces the previous one.
CREATE TABLE post_media (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('screenshot', 'video', 'poster')),
  -- 'automatic' (taken on publish) or 'uploaded' (recorded or chosen by the author).
  origin TEXT NOT NULL CHECK (origin IN ('automatic', 'uploaded')),
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  commit_sha TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  -- 'pending' until checked (size, type, image classification); 'ready'; 'rejected'.
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'rejected')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_post_media_post ON post_media(post_id, position);

CREATE TABLE follows (
  follower_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX idx_follows_followee ON follows(followee_id, created_at DESC);

CREATE TABLE post_likes (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('new_follower', 'project_copied', 'post_liked', 'post_removed')),
  actor_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES org_projects(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE post_reports (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  -- NULL for a visitor who is not signed in; their IP is kept only as its SHA-256, for rate limiting.
  reporter_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  reporter_ip_hash TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('scam_or_phishing', 'sexual', 'violent_or_hateful', 'copied_without_permission', 'spam', 'other')),
  note TEXT CHECK (length(note) <= 1000),
  state TEXT NOT NULL CHECK (state IN ('open', 'dismissed', 'actioned')),
  decided_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_post_reports_open ON post_reports(state, created_at);
```

`"user"` gains `bio TEXT` (at most 300 characters) and `showcase_paused_at INTEGER` (set by moderation: the person's
page and posts are hidden). `org_projects.copied_from` already records copies; `copy_count` is kept in step when a copy
is made.

**Feed query.** At current scale, read at request time with keyset pagination on (`shown_at`, `id`):

```sql
SELECT posts.* FROM posts
JOIN follows ON follows.followee_id = posts.author_id AND follows.follower_id = ?1
WHERE posts.status = 'visible' AND (posts.shown_at, posts.id) < (?2, ?3)
ORDER BY posts.shown_at DESC, posts.id DESC LIMIT 20;
```

Served by `idx_posts_author` per followee. This is fine to a few thousand follows per person and tens of thousands of
posts. The path to larger scale: a `feed_items (user_id, post_id, shown_at)` table written on publish (fan-out on
write) for authors with few followers, read at request time for authors with many; or one Durable Object per reader
holding their feed. Neither is needed now.

## Automatic posting without noise

The trigger is a successful production build of main for a project with `visibility = 'public'`, seen by the control
plane when it matches a commit to its Workers Builds build (`/runtime-projects/status` in
`app/server-handlers/runtime-projects.ts`, driven by `app/agents/linked-project-build.ts`'s watch; after wave 2,
item 1 this is the one publish path for every project). One function, `recordPublication(projectId, commit, pushedBy)`
in a new `app/lib/cloudflare/data/posts.server.ts`, called once per production build:

- No post yet: create one, `status = 'visible'`, author = the person whose push published (`project_main_pushes`),
  queue the screenshot. The author is told once, as a closable tip on the project: "Recipe Box is public, so it's now
  on your page. You can add a caption or video, or hide it."
- A visible post: set `commit_sha`, `site_url`, `published_count + 1`, `updated_at`, queue a new screenshot that
  replaces the automatic one (uploaded videos stay). Move `shown_at` (back to the top of feeds) only if the last move
  was more than 24 hours ago. A feed shows "Updated" beside a post whose `published_count > 1`.
- A hidden post: update what it shows, keep it hidden. Hiding is never undone by a publish.
- Making a project private sets its post `hidden` (`hidden_reason = 'project_private'`) and deletes its media; making
  it public again does not post until its next publish, or until the author chooses "Show on my page".

Hiding and removing, on the post's own menu (author only): "Hide from my page" (keeps the post, hides it from the page
and feeds), "Show on my page", "Delete post" (removes the post and its media; the next publish of a still-public
project makes a new one, which the confirmation says). Making the project private is how to stop posting for good.

## Media

**Automatic screenshot.** Browser Rendering in CloudChef's own account (a `BROWSER` binding on the control plane),
from a queue consumer, loads the site's public `site_url` at 1280x800, waits for network idle (10 s cap), captures a
WebP, and writes it to the `SHOWCASE_MEDIA` R2 bucket at `posts/<post id>/<media id>.webp`. Recommended over the
author's account: it works the same for every kind of space, needs no runtime change or upgrade, and keeps media and
the code that makes it in one place. Alternative: Browser Rendering in the author's account through their runtime,
which keeps the site's scripts out of CloudChef's account but needs a new binding in every runtime and fails when the
author's space is suspended or disconnected.

**Short video.** Recorded by the person in their browser and uploaded. On the post's menu, "Record a video" opens the
site in a frame on cloudchef.build and records that tab with `getDisplayMedia` and `MediaRecorder` (WebM/VP9, at most
30 seconds, at most 25 MB), or "Upload a video" takes an MP4/WebM file under the same limits. The browser uploads to
the control plane, which streams it to R2 and takes a poster frame from the client. Recommended over generated video
(a scripted Browser Rendering session): the person chooses what to show, and there is no scripted run of the site to
maintain. Alternative: Cloudflare Stream for transcoding and adaptive playback, which is worth it once videos are
long or many.

**Storage.** CloudChef's R2, settled by the owner. Consequences: posts survive the author disconnecting their
Cloudflare account or a managed space running out of credit (the live-site link may stop working, and the post says
"This site is offline" after a failed check); deletion follows the post, the project going private, and account
erasure (`app/server-handlers/account-deletion.ts`), and media is included in the account export
(`app/server-handlers/account-export.ts`). Media is served from `media.cloudchef.build` (an R2 custom domain) with
long cache lifetimes, keyed by media id so a replaced screenshot is a new URL.

**Checks before a media item is `ready`.** Content type and size from the bytes, not the header; image dimensions;
Workers AI image classification on screenshots and video poster frames for sexual or violent content, which holds
the item `pending` for operator review instead of showing it.

**Live view.** The post page can also show the live site in `SiteThumbnail`, as Explore does today, when
`site_frameable` is true; the image is shown first, the frame on request ("Try it here").

## Visibility

Public on the web (settled). Every visible post and every page with a username is readable without sign-in, has
social meta tags (a public variant beside `createPrivatePageHead` in `app/lib/social-meta.ts`, using the post's
screenshot as its image), and is indexable. Per-post visibility is not added: what is posted is exactly what is
public, and the project's own `visibility` is the one switch. A person with no username has no page.

## Team projects

A team project's `visibility` is set only by the person who manages it (`setProjectVisibility`: a team's admin), so a
team project is posted only after an admin made it public. Its post goes on the page of the member whose publish
created it and names the team: "Sara · Northside Bakery team". The team's admins can hide or delete it as its author
can. Recommended over posting to the admin's page: the person who built and published it is the one people would
follow. Alternative: team pages at the team's own name, which needs team usernames (not planned now).

A team member who is paused or removed keeps no control over the post; their existing posts of team projects stay
until an admin hides them.

## Make a copy from a post

The post's "Make a copy" opens the existing `CopyProjectDialog` (`POST /api/projects/copy`), which copies into the
signed-in person's space. A visitor who is not signed in is asked to sign in first; a signed-in person with no space
is offered one (their own Cloudflare account, or a managed space, `managed-spaces.md`). Until managed spaces exist,
people without a Cloudflare account or a team can view but not copy, and the button says "Sign in with Cloudflare to
make your own copy".

## Notifications

In-app only at first. The account menu's avatar shows a dot when there are unread notifications; its menu has
"Notifications", a list:

- "Sara started following you."
- "Ben made a copy of Recipe Box."
- "Sara liked Recipe Box." (grouped per post per day: "Sara and 3 others liked Recipe Box.")
- "Recipe Box was taken off your page because it was reported as a scam. Reply to this email if that's wrong."
  (also sent by email, from the existing `SIGN_IN_EMAIL` sender)

Email for anything else: none at first; a weekly email summary later, off by default.

## Moderation and abuse

- **Reporting**: "Report" on every post's menu, for visitors too (rate limited per IP hash, 5 a day). Three open
  reports from different people, or one `scam_or_phishing` report confirmed by Cloudflare's URL Scanner, hide the post
  automatically pending review.
- **Takedown**: an operator page `/reports` (operator user ids in an environment variable, not a role in D1) lists open
  reports with the post, screenshot and site; actions: dismiss; remove post (`status = 'removed'`, media deleted,
  author notified); pause the person's showcase (`showcase_paused_at`); for a managed space, suspend it
  (`managed-spaces.md`). `scripts/ops-report.mjs` counts open reports.
- **Phishing sites in the feed**: on each automatic post and each screenshot refresh, the site URL is submitted to
  Cloudflare's URL Scanner from CloudChef's account; a malicious verdict holds the post. A post's site link goes
  through an interstitial only when the post has open reports.
- **NSFW**: image classification on media (above); captions checked against a word list; the author's page is held
  for review after two removals.
- **Spam and fake accounts**: following is rate limited (100 a day); new accounts' posts are shown on their own page
  but enter followers' feeds only after the account is 24 hours old.
- **Terms**: `app/routes/terms.tsx` gains what may be posted and how takedown works.

## Privacy

- Nothing posts unless the project is public, and a team project is public only by an admin's choice.
- A post shows the published site, a screenshot of its public page, the caption, the author's name, username and
  bio. No chat, code or commit message is shown on the post (the code is reachable through the public project as
  today, for signed-in people).
- Follows are public on a person's page as counts only; the lists are visible only to the person.
- Likes: the count is public; who liked is visible only to the author.
- Erasing an account deletes its posts, media, follows, likes and notifications (foreign keys cascade; R2 objects
  deleted by the erasure job).

## Routes and interface

The header keeps only the project and the account. Everything else is on the object it acts on or in the projects
sidebar.

| Route                | Who       | What                                                                                                           |
| -------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `/<username>`        | anyone    | The person's page: name, bio, Follow, a grid of their visible posts (screenshot or video poster, newest first) |
| `/<username>/<slug>` | anyone    | The post: media, caption, Open site, Make a copy, like, Report; for the project's members, its project page    |
| `/feed`              | signed in | Posts from people you follow, newest first; empty state links to Explore                                       |
| `/explore`           | anyone    | Everyone's visible posts, newest first (replacing today's public-projects list)                                |
| `/notifications`     | signed in | The list above                                                                                                 |
| `/reports`           | operator  | Moderation                                                                                                     |

`feed`, `explore`, `notifications`, `reports`, `media`, `approvals` are added to `RESERVED` in `app/lib/usernames.ts`
(checked against production usernames first). `/<username>/<slug>` is the same address as the project's git URL
without `.git`, so a shared link and a clone address match.

Surfaces:

- **Projects sidebar**: "Feed" and "Explore" beside the space switcher, and "Your page".
- **Project card menu** (projects home): "Make public" already lives there; when public, "View post".
- **Post menu** (on the post, author only): Edit caption, Record a video, Upload a video, Hide from my page, Delete
  post. For others: Report.
- **Account menu**: Notifications, Your page, Settings, Log out.
- Guidance is a closable tip, never a banner or a line in the terminal.

## How this helps people work together

- Discovery: a feed of people you follow and Explore show what others built, with the live site one click away.
- Sharing a link: `cloudchef.build/<username>/<slug>` works for anyone, signed in or not, with a preview image
  wherever it is pasted.
- Copies: "Make a copy" on a post starts someone's own version; the copy records where it came from (`copied_from`),
  the post counts copies, and the author is told. Working on the same project together stays with sharing (wave 3,
  item 1).

## Code that changes

- New: `app/lib/cloudflare/data/posts.server.ts` (posts, media, follows, likes, feed), `app/server-handlers/showcase.ts`
  (routes' data, uploads, reports), `app/lib/.server/showcase/screenshot.ts` (Browser Rendering, queue consumer),
  routes `app/routes/$username.tsx`, `app/routes/$username.$slug.tsx`, `app/routes/feed.tsx`,
  `app/routes/notifications.tsx`, `app/routes/reports.tsx`, components under `app/components/showcase/`.
- `cloudflare.config.ts`: `SHOWCASE_MEDIA` R2 bucket, `BROWSER` Browser Rendering binding, a `SHOWCASE_SCREENSHOTS`
  queue and its consumer, `SHOWCASE_REPORT_RATE_LIMITER`, `OPERATOR_USER_IDS`.
- `app/server.ts`: routes and the queue handler.
- `app/server-handlers/runtime-projects.ts`: call `recordPublication` on a production build's success.
- `app/lib/cloudflare/data/org-projects.server.ts`: `setProjectVisibility` hides the post when a project goes private;
  copying increments `copy_count` and notifies.
- `app/routes/explore.tsx`, `app/components/projects/Explore.client.tsx`: public, post-based.
- `app/lib/usernames.ts`: reserved names. `app/lib/social-meta.ts`: public page head.
- `app/server-handlers/account-deletion.ts`, `account-export.ts`: posts and media.
- ARCHITECTURE.md (Account Boundary exception, State Ownership rows for posts and media), CLAUDE.md (invariant, code
  index), `app/routes/privacy.tsx` and `terms.tsx`.

No workspace runtime change, so no runtime upgrade.

## Release order

1. **Release A**: migration with all tables and `"user"` columns; bindings; reserved usernames; posts made by
   `recordPublication`, pages and post routes public, reports and `/reports`; no feed yet. Control plane only.
2. **Release B**: follows, likes, feed, notifications, video upload and recording; Explore switches to posts.
3. If Explore's old `listPublicProjects` query or columns are no longer used, removing them is a code-only change;
   nothing is dropped from D1.

## Decisions for the owner

| Decision                                         | Recommendation                                         | Reason / alternative                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| One post per project, updated by later publishes | Yes                                                    | Keeps feeds calm with automatic posting / a post per publish, collapsed in the feed, which keeps history but is noisier  |
| How often a republish moves a post up in feeds   | At most once a day                                     | Shows real updates without flooding / never, so only the first publish appears                                           |
| Whose page a team project's post goes on         | The member whose publish made it, naming the team      | People follow the builder / team pages, which need team usernames                                                        |
| Where screenshots are taken                      | Browser Rendering in CloudChef's account               | Works for every space, no runtime upgrade / in the author's account, which keeps site scripts out of CloudChef's account |
| Video                                            | Recorded or uploaded by the person, 30 s, 25 MB, in R2 | Simple and in their control / Cloudflare Stream once videos are longer or many                                           |
| Likes                                            | Yes, count public, likers visible to the author only   | Gives the post its familiar feel without a public popularity list / no likes, calmer                                     |
| Comments                                         | Not now                                                | Moderation cost / add later with the same report path                                                                    |
| Explore without sign-in                          | Yes, it lists the same public posts                    | Pages are public anyway / keep Explore signed-in only                                                                    |
| Copy for people with no space                    | Offer a managed space (after managed spaces ship)      | Copies need an account to land in / view only until then                                                                 |
| Operator moderation                              | Operator ids in an environment variable                | No admin role in D1 to protect / a `user.is_operator` column                                                             |

## Risks

- **CloudChef hosts public user content**: media, captions and links to sites are on cloudchef.build, so reports,
  takedown requests and legal notices come to CloudChef, from the first release.
- **Screenshots run sites' scripts in CloudChef's account** (Browser Rendering): bounded by the 10-second cap, no
  cookies, and no CloudChef credentials in that browser.
- **Screenshot staleness**: a site that changes data without a publish shows an old screenshot; refreshed on each
  publish only.
- **Routes at `/<username>`** can collide with future CloudChef pages; every new top-level route must be reserved
  first.
- **Automatic posting surprises**: a person may make a project public to share code without wanting it on their page;
  the one-time tip and "Hide from my page" cover that, and the "Make public" confirmation says it will appear on their
  page.
