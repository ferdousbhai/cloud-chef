import { createServerFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { findPerson, findPostByAddress, listExplorePosts, listPersonPosts } from '~/lib/cloudflare/data/posts.server';
import type { PostView, PublicPerson, ShowcaseCursor } from '~/lib/showcase';

/**
 * What the public showcase pages (a person's page, a post, Explore) are rendered from, on the server for a first
 * visit and through these same functions when the browser moves between them. Only what anyone may see is read
 * here: nothing about who is looking, so the pages render the same for everyone and a link preview shows them too.
 * What differs for a signed-in person (likes, follows, their own controls) comes after, from /api/showcase/viewer.
 */

const USERNAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const SLUG = /^[a-z0-9-]{1,64}$/;

/** The control plane's database. Absent only where pages are rendered without one (the built-server smoke test). */
function database(): D1Database | null {
  // SAFETY: the Worker's bindings, except in the smoke test, whose stand-in module may have none at all.
  return (env as Partial<Env> | undefined)?.DB ?? null;
}

export type PersonPageData = { person: PublicPerson; posts: PostView[]; next: ShowcaseCursor | null } | null;

/** `/<username>`: the person and their newest posts, or null when nobody by that name has a page. */
export const loadPersonPage = createServerFn({ method: 'GET' })
  .validator((username: string) => username)
  .handler(async ({ data: username }): Promise<PersonPageData> => {
    const db = database();
    if (!db || !USERNAME.test(username)) {
      return null;
    }
    const person = await findPerson(db, username);
    if (!person) {
      return null;
    }
    return { person, ...(await listPersonPosts(db, username)) };
  });

export type PostPageData = { post: PostView | null; project: { id: string; name: string } } | null;

/**
 * `/<owner>/<slug>`: the post of the public project at that address. `post` is null when the project is public but
 * its post isn't shown; the whole answer is null when there is no public project there.
 */
export const loadPostPage = createServerFn({ method: 'GET' })
  .validator((address: { owner: string; slug: string }) => address)
  .handler(async ({ data }): Promise<PostPageData> => {
    const db = database();
    if (!db || !USERNAME.test(data.owner) || !SLUG.test(data.slug)) {
      return null;
    }
    const found = await findPostByAddress(db, data.owner, data.slug);
    return found.project ? { post: found.post, project: found.project } : null;
  });

export type ExplorePageData = { posts: PostView[]; next: ShowcaseCursor | null };

/** `/explore`: everyone's newest posts. */
export const loadExplorePage = createServerFn({ method: 'GET' }).handler(async (): Promise<ExplorePageData> => {
  const db = database();
  if (!db) {
    return { posts: [], next: null };
  }
  return listExplorePosts(db);
});
