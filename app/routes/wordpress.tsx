import { createFileRoute } from '@tanstack/react-router';
import { MovePage } from '~/components/move/MovePage';
import { createSocialPageHead } from '~/lib/social-meta';

/** The same page as `/move`, opening on a WordPress site: the content moves into the new app. */
export const Route = createFileRoute('/wordpress')({
  head: () =>
    createSocialPageHead({
      title: 'Move your WordPress site to your own web app | CloudChef',
      description:
        'CloudChef rebuilds your WordPress site as your own web app in your own Cloudflare account, with your content moved in and an editor you sign in to.',
      path: '/wordpress',
      imagePath: '/social-preview-home-v4.png',
      imageAlt: 'CloudChef — build and ship Cloudflare apps',
    }),
  component: () => <MovePage variant="wordpress" />,
});
