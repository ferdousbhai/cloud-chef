import { LinkButton } from '~/components/ui/LinkButton';
import { useViewer } from '~/lib/showcase-api';
import { HiddenPosts } from './PersonPage';
import { ShowcaseNotice } from './ShowcaseShell';

/**
 * `/<username>` with no public page: nobody by that name, or someone who hasn't posted anything anyone may see yet.
 * The server renders the same page for everyone; only once the browser knows the viewer is that person does it say
 * where their page will be, and the posts they hid, which nobody else ever sees.
 */
export function PersonNotFound({ username }: { username: string }) {
  const { viewer } = useViewer([]);
  if (viewer?.signedIn && viewer.me.username === username) {
    return (
      <ShowcaseNotice title="Your page">
        <p>Your page appears here when you publish a public project. Only you can see this.</p>
        <p>
          <LinkButton to="/" variant="neutral">
            Your projects
          </LinkButton>
        </p>
        <div className="text-left">
          <HiddenPosts />
        </div>
      </ShowcaseNotice>
    );
  }
  return (
    <ShowcaseNotice title="This page does not exist.">
      <p>
        <LinkButton to="/explore" variant="neutral">
          See what people made
        </LinkButton>
      </p>
    </ShowcaseNotice>
  );
}
