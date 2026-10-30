import { createFileRoute, notFound } from '@tanstack/react-router';
import { PostNotShown, PostPage } from '~/components/showcase/PostPage';
import { ShowcaseShell } from '~/components/showcase/ShowcaseShell';
import { loadPostPage } from '~/lib/showcase-loaders';
import { createPublicPageHead } from '~/lib/social-meta';

/**
 * A public project's post at the project's own address, `/<owner>/<slug>` (its clone address without `.git`): public
 * on the web, no sign-in to look.
 */
export const Route = createFileRoute('/$username/$slug')({
  loader: async ({ params }) => {
    const data = await loadPostPage({ data: { owner: params.username, slug: params.slug } });
    if (!data) {
      throw notFound();
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
});

function PostRoute() {
  const data = Route.useLoaderData();
  return (
    <ShowcaseShell>
      {data.post ? <PostPage key={data.post.id} post={data.post} /> : <PostNotShown projectName={data.project.name} />}
    </ShowcaseShell>
  );
}
