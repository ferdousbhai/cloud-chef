import { createFileRoute, notFound } from '@tanstack/react-router';
import { PersonPage } from '~/components/showcase/PersonPage';
import { PersonNotFound } from '~/components/showcase/PersonNotFound';
import { ShowcaseShell } from '~/components/showcase/ShowcaseShell';
import { loadPersonPage } from '~/lib/showcase-loaders';
import { createPublicPageHead } from '~/lib/social-meta';

/** A person's page at their username: public on the web, no sign-in to look. */
export const Route = createFileRoute('/$username/')({
  loader: async ({ params }) => {
    const data = await loadPersonPage({ data: params.username });
    if (!data) {
      throw notFound();
    }
    return data;
  },
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {};
    }
    const { person, posts } = loaderData;
    const cover = posts.find((post) => post.screenshot)?.screenshot;
    return createPublicPageHead({
      title: `${person.name} (@${person.username}) | CloudChef`,
      description:
        person.bio ??
        `${person.name} has ${person.posts === 1 ? '1 project' : `${person.posts} projects`} on CloudChef. See what they made.`,
      path: `/${person.username}`,
      image: cover
        ? {
            path: cover.url,
            width: cover.width,
            height: cover.height,
            alt: `What ${person.name} made`,
            type: 'image/webp',
          }
        : null,
    });
  },
  component: PersonRoute,
  // The same for everyone on the server: no page here. Its own person learns, in the browser, where theirs will be.
  notFoundComponent: PersonMissing,
});

function PersonMissing() {
  const { username } = Route.useParams();
  return (
    <ShowcaseShell>
      <PersonNotFound username={username} />
    </ShowcaseShell>
  );
}

function PersonRoute() {
  const data = Route.useLoaderData();
  return (
    <ShowcaseShell>
      <PersonPage key={data.person.username} person={data.person} posts={data.posts} next={data.next} />
    </ShowcaseShell>
  );
}
