import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION } from '@cloudchef/user-workspace-runtime/protocol';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { USER_WORKSPACE_IMAGE } from '~/lib/.server/cloudflare/user-workspace-image';
import { runtimeIdentityHeaders } from '~/lib/.server/cloudflare/runtime-identity-headers';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { createAuthSession, getAuthSession } from '~/lib/.server/auth';
import { answerMention } from '~/lib/.server/showcase/mention-runs';
import { recordPublication } from '~/lib/cloudflare/data/posts.server';
import { addReply, findThread, markThreadOnItsWay, startThread } from '~/lib/cloudflare/data/post-threads.server';
import { controlPlaneDatabase, createProvenEmailUser, envWith } from '~/test/control-plane-d1';
import type { CommentsRequest } from '~/lib/thread-comments';
import { runtimeCommentsAction, runtimeCommentsAnsweredAction } from './runtime-comments';
import { runtimeSharedAction } from './runtime-shared';
import { closeThreadsThatWentLive } from './threads-went-live';

const ORIGIN = 'https://cloudchef.build';
const KEY = btoa('k'.repeat(32));
const RECIPES = '44444444-4444-4444-8444-444444444444';
const LIVE = 'a'.repeat(40);
const FIX = 'b'.repeat(40);
const LATER = 'c'.repeat(40);

const answerSchema = z.record(z.string(), z.unknown());
/** What CloudChef sends a runtime to start a mention's turn, as far as these tests read it. */
const startSchema = z.looseObject({ chatId: z.string(), text: z.string() });
type StartBody = z.infer<typeof startSchema>;

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Ada's public Recipe Box with its post, in her own account; Bo with an account of his own; Cy with nowhere to
 * build yet. Each with a username, and the first two with a workspace runtime CloudChef can reach.
 */
async function world() {
  const { database, db } = controlPlaneDatabase();
  const env = envWith({ DB: db, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: KEY });
  const person = async (email: string, username: string, space: boolean) => {
    const user = await createProvenEmailUser(db, email);
    await db.prepare('UPDATE "user" SET username = ? WHERE id = ?').bind(username, user.id).run();
    const cookie = (await createAuthSession(env, user.id, new Request(`${ORIGIN}/`))).cookie.split(';')[0]!;
    const connection = `${username}-own`;
    if (space) {
      database.exec(`
        INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, created_at)
          VALUES ('cred-${username}', 'x', 'y', 1);
        INSERT INTO cloudflare_authorizations (account_id, credential_handle, created_at, updated_at)
          VALUES ('account-${username}', 'cred-${username}', 1, 1);
      `);
      database
        .prepare(
          `INSERT INTO cloudflare_connections (id, user_id, account_id, status, connection_generation, created_at,
             updated_at) VALUES (?, ?, ?, 'active', 1, 1, 1)`,
        )
        .run(connection, user.id, `account-${username}`);
      database
        .prepare(
          `INSERT INTO user_computer_runtimes (user_id, connection_id, connection_generation, worker_name, endpoint,
             runtime_version, image_digest, protocol_version, status, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'ready', 1, 1)`,
        )
        .run(
          user.id,
          connection,
          `${username}-worker`,
          `https://${username}.runtime.test`,
          USER_WORKSPACE_RUNTIME_SHA256,
          USER_WORKSPACE_IMAGE,
          USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION,
        );
    }
    /** A request from this person's runtime, as every runtime route is called. */
    const runtime = async (path: string, json: string | undefined, headers: HeadersInit = {}) => {
      const secret = await deriveUserWorkspaceRuntimeSecret({
        encryptionKeyBase64: KEY,
        userId: user.id,
        accountId: `account-${username}`,
        connectionGeneration: 1,
        organizationConnectionId: null,
      });
      return new Request(`${ORIGIN}${path}`, {
        method: json === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          ...runtimeIdentityHeaders({ userId: user.id, connectionId: connection, connectionGeneration: 1 }),
          ...headers,
        },
        body: json,
      });
    };
    const session = async () => (await getAuthSession(env, new Request(`${ORIGIN}/`, { headers: { cookie } })))!;
    return { userId: user.id, connection, runtime, session };
  };
  const ada = await person('ada@example.com', 'ada', true);
  const bo = await person('bo@example.com', 'bo', true);
  const cy = await person('cy@example.com', 'cy', false);
  database
    .prepare(
      `INSERT INTO org_projects (id, connection_id, name, slug, artifact_repo, created_from, deploys_with, visibility,
         created_by, site_url, created_at) VALUES (?, 'ada-own', 'Recipe Box', 'recipe-box', 't-recipes', 'chat',
         'cloudchef', 'public', ?, 'https://recipes.example.workers.dev', 1)`,
    )
    .run(RECIPES, ada.userId);
  await recordPublication(db, { projectId: RECIPES, commit: LIVE, by: ada.userId, siteUrl: null });
  // SAFETY: the column selected is the posts table's id, of the row this test made.
  const postId = (database.prepare('SELECT id FROM posts WHERE project_id = ?').get(RECIPES) as { id: string }).id;
  const comments = async (as: typeof ada, body: CommentsRequest) => {
    const response = await runtimeCommentsAction({
      request: await as.runtime('/api/cloudflare/runtime-projects/comments', JSON.stringify(body)),
      env,
    });
    return { status: response.status, body: answerSchema.parse(await response.json()) };
  };
  return { database, db, env, ada, bo, cy, postId, comments };
}

describe('cloudchef comments', () => {
  it('lists the open and on-its-way threads, and shows one whole, for anyone who may read the project', async () => {
    const { db, ada, bo, postId, comments } = await world();
    const first = await startThread(db, { userId: bo.userId, postId, body: 'The date picker fails on phones' });
    await addReply(db, { userId: ada.userId, threadId: first.id, body: 'Looking at it' });
    const second = await startThread(db, { userId: bo.userId, postId, body: 'Dark mode?' });
    await markThreadOnItsWay(db, { userId: ada.userId, threadId: second.id, fixCommit: FIX });
    await startThread(db, { userId: bo.userId, postId, body: 'Closed one' }).then((closed) =>
      db.prepare(`UPDATE post_comments SET state = 'closed' WHERE id = ?`).bind(closed.id).run(),
    );

    const listed = await comments(bo, { op: 'list', orgProjectId: RECIPES });
    expect(listed.status).toBe(200);
    expect(listed.body.post).toBe('/ada/recipe-box');
    expect(z.array(z.looseObject({ number: z.number(), state: z.string() })).parse(listed.body.threads)).toEqual([
      expect.objectContaining({ number: 1, state: 'open', by: 'bo', replies: 1, earlierVersion: false }),
      expect.objectContaining({ number: 2, state: 'on_its_way' }),
    ]);

    const shown = await comments(bo, { op: 'show', orgProjectId: RECIPES, number: 1 });
    expect(shown.status).toBe(200);
    expect(shown.body.replies).toEqual([expect.objectContaining({ by: 'ada', body: 'Looking at it', byAgent: false })]);
    expect((await comments(bo, { op: 'show', orgProjectId: RECIPES, number: 9 })).status).toBe(404);
  });

  it('closes only from the chat a mention in that thread started, with edit access, while it answers', async () => {
    const { db, database, ada, bo, postId, comments } = await world();
    const thread = await startThread(db, { userId: bo.userId, postId, body: '@cloudchef the list is empty' });
    const close = (as: typeof ada, chatId: string, reason: 'changed' | 'not_planned' = 'changed') =>
      comments(as, {
        op: 'close',
        orgProjectId: RECIPES,
        number: 1,
        reason,
        chatId,
        fixCommit: reason === 'changed' ? FIX : undefined,
      });

    // No mention run: refused, even for the project's owner.
    expect((await close(ada, 'ada-chat')).status).toBe(403);
    database
      .prepare(
        `INSERT INTO thread_runs (thread_id, user_id, chat_id, access, answering_id, created_at)
         VALUES (?, ?, 'ada-chat', 'edit', ?, 1), (?, ?, 'bo-chat', 'read', ?, 1)`,
      )
      .run(thread.id, ada.userId, thread.id, thread.id, bo.userId, thread.id);
    // Another chat of hers, or Bo's read-only run: refused.
    expect((await close(ada, 'other-chat')).status).toBe(403);
    expect((await close(bo, 'bo-chat')).status).toBe(403);
    // Her mention's chat, while it answers: on its way until main's commit goes live.
    const closed = await close(ada, 'ada-chat');
    expect(closed).toEqual({ status: 200, body: { state: 'on_its_way' } });
    expect((await findThread(db, thread.id, null))?.state).toBe('on_its_way');
    // Once its turn ended, no more.
    database.prepare('UPDATE thread_runs SET answering_id = NULL').run();
    expect((await close(ada, 'ada-chat', 'not_planned')).status).toBe(403);
  });
});

describe('a mention turn ending', () => {
  it('posts the final message as CloudChef’s reply once, and nothing for a stopped turn or another chat', async () => {
    const { db, database, bo, postId, env } = await world();
    const thread = await startThread(db, { userId: bo.userId, postId, body: '@cloudchef how does this store lists?' });
    database
      .prepare(
        `INSERT INTO thread_runs (thread_id, user_id, chat_id, access, answering_id, created_at)
         VALUES (?, ?, 'bo-chat', 'read', ?, 1)`,
      )
      .run(thread.id, bo.userId, thread.id);
    const answered = async (chatId: string, outcome: string, text: string) =>
      answerSchema.parse(
        await (
          await runtimeCommentsAnsweredAction({
            request: await bo.runtime(
              '/api/cloudflare/runtime-projects/comments/answered',
              JSON.stringify({
                threadId: thread.id,
                commentId: thread.id,
                chatId,
                outcome,
                text,
              }),
            ),
            env,
          })
        ).json(),
      );
    expect(await answered('another-chat', 'answered', 'Nope')).toEqual({ posted: false });
    expect(await answered('bo-chat', 'answered', 'In a D1 table, one row per item.')).toEqual({ posted: true });
    expect(await answered('bo-chat', 'answered', 'Again')).toEqual({ posted: false });
    const replies = database
      .prepare('SELECT body, by_agent, author_id FROM post_comments WHERE parent_id = ?')
      .all(thread.id);
    expect(replies).toEqual([{ body: 'In a D1 table, one row per item.', by_agent: 1, author_id: bo.userId }]);
    expect(database.prepare('SELECT answering_id FROM thread_runs').get()).toEqual({ answering_id: null });
  });

  it('posts that CloudChef couldn’t finish, with why, for a failed turn; nothing for a stopped one', async () => {
    const { db, database, bo, postId, env } = await world();
    const thread = await startThread(db, { userId: bo.userId, postId, body: '@cloudchef fix it' });
    const run = (outcome: string, text: string) =>
      bo
        .runtime(
          '/api/cloudflare/runtime-projects/comments/answered',
          JSON.stringify({
            threadId: thread.id,
            commentId: thread.id,
            chatId: 'bo-chat',
            outcome,
            text,
          }),
        )
        .then((request) => runtimeCommentsAnsweredAction({ request, env }));
    const claim = () =>
      database
        .prepare(
          `INSERT OR REPLACE INTO thread_runs (thread_id, user_id, chat_id, access, answering_id, created_at)
           VALUES (?, ?, 'bo-chat', 'read', ?, 1)`,
        )
        .run(thread.id, bo.userId, thread.id);
    claim();
    await run('stopped', '');
    claim();
    await run('failed', 'No model was available for this turn.');
    expect(database.prepare('SELECT body FROM post_comments WHERE parent_id = ?').all(thread.id)).toEqual([
      { body: 'CloudChef couldn’t finish this: No model was available for this turn.' },
    ]);
  });
});

describe('@cloudchef', () => {
  function stubRuntime(answer: (body: StartBody) => Response) {
    const calls: { url: string; body: StartBody }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = startSchema.parse(JSON.parse(String(init?.body)));
        calls.push({ url: String(input), body });
        return answer(body);
      }),
    );
    return calls;
  }

  it('starts a read-only run in the asker’s own space for someone who can’t edit, and later mentions go to it', async () => {
    const { db, database, env, bo, postId } = await world();
    const calls = stubRuntime((body) => Response.json({ status: 'started', chatId: body.chatId }));
    const thread = await startThread(db, { userId: bo.userId, postId, body: '@cloudchef how does this work?' });
    const request = new Request(`${ORIGIN}/api/showcase/comments/add`);
    const answer = await answerMention(env, {
      request,
      session: await bo.session(),
      threadId: thread.id,
      commentId: thread.id,
    });
    expect(answer).toEqual({ status: 'working' });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).origin).toBe('https://bo.runtime.test');
    expect(calls[0]!.body).toMatchObject({
      access: 'read',
      commentId: thread.id,
      thread: { threadId: thread.id, number: 1, post: '/ada/recipe-box', access: 'read' },
      question: { projectId: RECIPES, commit: LIVE, post: '/ada/recipe-box' },
    });
    expect(String(calls[0]!.body.text)).toContain('@cloudchef how does this work?');
    expect(await findThread(db, thread.id, null)).toMatchObject({ working: true });

    // A second mention while the first is answered: busy, and nothing is sent.
    const reply = await addReply(db, { userId: bo.userId, threadId: thread.id, body: '@cloudchef and also this' });
    const busy = await answerMention(env, {
      request,
      session: await bo.session(),
      threadId: thread.id,
      commentId: reply.id,
    });
    expect(busy?.status).toBe('busy');
    expect(calls).toHaveLength(1);

    // Once answered, the next mention goes to the same chat.
    database.prepare('UPDATE thread_runs SET answering_id = NULL').run();
    await answerMention(env, { request, session: await bo.session(), threadId: thread.id, commentId: reply.id });
    expect(calls[1]!.body.chatId).toBe(calls[0]!.body.chatId);
    expect(String(calls[1]!.body.text)).toContain(
      'The comment that mentioned you, by @bo:\n> @cloudchef and also this',
    );
  });

  it('starts a full run on the project for someone who can edit it, in its own account', async () => {
    const { db, env, ada, bo, postId } = await world();
    const calls = stubRuntime(() => Response.json({ status: 'started', chatId: 'ada-project-chat' }));
    const thread = await startThread(db, { userId: bo.userId, postId, body: 'The list is empty' });
    const reply = await addReply(db, { userId: ada.userId, threadId: thread.id, body: '@cloudchef fix this' });
    const answer = await answerMention(env, {
      request: new Request(`${ORIGIN}/api/showcase/comments/add`),
      session: await ada.session(),
      threadId: thread.id,
      commentId: reply.id,
    });
    expect(answer).toEqual({ status: 'working' });
    expect(new URL(calls[0]!.url).origin).toBe('https://ada.runtime.test');
    expect(calls[0]!.body).toMatchObject({ access: 'edit', orgProjectId: RECIPES, thread: { access: 'edit' } });
    expect(calls[0]!.body.question).toBeUndefined();
  });

  it('tells someone with nowhere to build to choose first, and posts why a run couldn’t start', async () => {
    const { db, database, env, bo, cy, postId } = await world();
    const asked = await startThread(db, { userId: cy.userId, postId, body: '@cloudchef hi' });
    const request = new Request(`${ORIGIN}/api/showcase/comments/add`);
    const noSpace = await answerMention(env, {
      request,
      session: await cy.session(),
      threadId: asked.id,
      commentId: asked.id,
    });
    expect(noSpace?.status).toBe('no_space');
    expect(database.prepare('SELECT body, by_agent FROM post_comments WHERE parent_id = ?').all(asked.id)).toEqual([
      { body: 'Choose where to build first, then ask again. https://cloudchef.build/', by_agent: 1 },
    ]);

    stubRuntime(() => Response.json({ error: 'The workspace is upgrading.' }, { status: 409 }));
    const thread = await startThread(db, { userId: bo.userId, postId, body: '@cloudchef hello' });
    const failed = await answerMention(env, {
      request,
      session: await bo.session(),
      threadId: thread.id,
      commentId: thread.id,
    });
    expect(failed).toEqual({ status: 'failed', message: 'The workspace is upgrading.' });
    expect(database.prepare('SELECT body FROM post_comments WHERE parent_id = ?').all(thread.id)).toEqual([
      { body: 'CloudChef couldn’t finish this: The workspace is upgrading.' },
    ]);
    expect(database.prepare('SELECT answering_id FROM thread_runs WHERE thread_id = ?').get(thread.id)).toEqual({
      answering_id: null,
    });
  });
});

describe('a change going live', () => {
  it('closes the threads whose change the published version holds, asking the project’s account', async () => {
    const { db, env, ada, bo, postId } = await world();
    const waiting = await startThread(db, { userId: bo.userId, postId, body: 'Add sorting' });
    const exact = await startThread(db, { userId: bo.userId, postId, body: 'Fix the title' });
    const later = await startThread(db, { userId: bo.userId, postId, body: 'Add tags' });
    await markThreadOnItsWay(db, { userId: ada.userId, threadId: waiting.id, fixCommit: FIX });
    await markThreadOnItsWay(db, { userId: ada.userId, threadId: exact.id, fixCommit: LATER });
    await markThreadOnItsWay(db, { userId: ada.userId, threadId: later.id, fixCommit: 'd'.repeat(40) });
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        asked.push(String(input));
        return Response.json({ live: [FIX] });
      }),
    );
    await closeThreadsThatWentLive(new Request(`${ORIGIN}/api/cloudflare/runtime-projects/deployments/report`), env, {
      projectId: RECIPES,
      connectionId: 'ada-own',
      commit: LATER,
      reportedBy: ada.userId,
      at: 1_000,
    });
    expect(asked).toHaveLength(1);
    const url = new URL(asked[0]!);
    expect(url.origin + url.pathname).toBe(`https://ada.runtime.test/v1/shared/${RECIPES}/ancestors`);
    expect(url.searchParams.get('commit')).toBe(LATER);
    expect(url.searchParams.get('of')?.split(',')).toEqual(expect.arrayContaining([FIX, 'd'.repeat(40)]));
    expect((await findThread(db, waiting.id, null))?.state).toBe('closed');
    expect((await findThread(db, exact.id, null))?.state).toBe('closed');
    expect((await findThread(db, later.id, null))?.state).toBe('on_its_way');
  });

  it('leaves them on their way when the project’s account can’t say', async () => {
    const { db, env, ada, bo, postId } = await world();
    const waiting = await startThread(db, { userId: bo.userId, postId, body: 'Add sorting' });
    await markThreadOnItsWay(db, { userId: ada.userId, threadId: waiting.id, fixCommit: FIX });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not found.', { status: 404 })),
    );
    await closeThreadsThatWentLive(new Request(`${ORIGIN}/x`), env, {
      projectId: RECIPES,
      connectionId: 'ada-own',
      commit: LATER,
      reportedBy: ada.userId,
      at: 1_000,
    });
    expect((await findThread(db, waiting.id, null))?.state).toBe('on_its_way');
  });
});

describe('a public project’s reads for someone it isn’t shared with', () => {
  it('reads it through its own account, never its git', async () => {
    const { env, bo } = await world();
    const forwarded: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        forwarded.push(String(input));
        return new Response('ok');
      }),
    );
    const ask = async (op: string, method = 'GET') =>
      (
        await runtimeSharedAction({
          request: await bo.runtime(
            `/api/cloudflare/runtime-shared/${RECIPES}/${op}`,
            method === 'POST' ? 'pack' : undefined,
            { 'x-cloudchef-workspace': 'reads' },
          ),
          env,
        })
      ).status;
    expect(await ask('files')).toBe(200);
    expect(await ask('git/info/refs')).toBe(403);
    expect(await ask('git/git-receive-pack', 'POST')).toBe(403);
    expect(forwarded.map((url) => new URL(url).origin)).toEqual(['https://ada.runtime.test']);
  });
});
