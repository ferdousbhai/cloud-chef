import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { MemberPost, PostNotShown, PostPage } from '~/components/showcase/PostPage';
import { ShowcaseShell } from '~/components/showcase/ShowcaseShell';
import { loadPostPage } from '~/lib/showcase-loaders';
import { createPublicPageHead } from '~/lib/social-meta';

/**
 * A project's post at its own address, `/<owner>/<slug>` (its clone address without `.git`). A public project's is
 * rendered on the server, for anyone, no sign-in to look. Anything else is rendered the same for everyone too, and the
 * browser then asks for a private project's post with the person's session (`MemberPost`).
 */
export const Route = createFileRoute('/$username/$slug')({
  loader: async ({ params }) => {
    const data = await loadPostPage({ data: { owner: params.username, slug: params.slug } });
    if (!data) {
      throw notFound();
    }
    if (data.project.slug !== params.slug) {
      throw redirect({
        to: '/$username/$slug',
        params: { username: params.username, slug: data.project.slug },
        statusCode: 301,
      });
    }
    return data;
  },
  head: ({ loaderData, params }) => {
    if (!loaderData) {
      return {};
    }
    const { post, project } = loaderData;
    const path = `/${params.username}/${params.slug}`;
    if (!post) {
      return createPublicPageHead({
        title: `${project.name} | CloudChef`,
        description: 'A project on CloudChef.',
        path,
      });
    }
    const picture = post.screenshot ?? null;
    return createPublicPageHead({
      title: `${post.title} by ${post.author.name} | CloudChef`,
      description:
        post.caption?.slice(0, 200) || `${post.title}, made by ${post.author.name} with CloudChef. Try it live.`,
      path,
      image: picture
        ? {
            path: picture.url,
            width: picture.width,
            height: picture.height,
            alt: `${post.title}, as it looks live`,
            type: 'image/webp',
          }
        : null,
    });
  },
  component: PostRoute,
  // The same for everyone on the server: nothing here. Someone who may view a private project there sees its post, in
  // the browser.
  notFoundComponent: PostMissing,
});

function PostMissing() {
  const { username, slug } = Route.useParams();
  return (
    <ShowcaseShell>
      <MemberPost owner={username} slug={slug} />
    </ShowcaseShell>
  );
}

function PostRoute() {
  const data = Route.useLoaderData();
  return (
    <ShowcaseShell>
      {data.post ? <PostPage key={data.post.id} post={data.post} /> : <PostNotShown projectName={data.project.name} />}
    </ShowcaseShell>
  );
}
