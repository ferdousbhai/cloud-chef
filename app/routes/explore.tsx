import { createFileRoute } from '@tanstack/react-router';
import { ExplorePage } from '~/components/showcase/ExplorePage';
import { ShowcaseShell } from '~/components/showcase/ShowcaseShell';
import { loadExplorePage } from '~/lib/showcase-loaders';
import { createPublicPageHead } from '~/lib/social-meta';

/** Everyone's posts, newest first: public on the web, no sign-in to look. */
export const Route = createFileRoute('/explore')({
  loader: () => loadExplorePage(),
  head: () =>
    createPublicPageHead({
      title: 'Explore | CloudChef',
      description: 'What people made with CloudChef: live apps and sites to try, and to make your own.',
      path: '/explore',
    }),
  component: ExploreRoute,
});

function ExploreRoute() {
  const data = Route.useLoaderData();
  return (
    <ShowcaseShell>
      <ExplorePage posts={data.posts} next={data.next} />
    </ShowcaseShell>
  );
}
