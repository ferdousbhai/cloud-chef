import { createFileRoute } from '@tanstack/react-router';
import { MovePage } from '~/components/move/MovePage';
import { createSocialPageHead } from '~/lib/social-meta';

/** A site someone runs on a rented platform, moved in: rebuilt as their own web app in their own Cloudflare account. */
export const Route = createFileRoute('/move')({
  head: () =>
    createSocialPageHead({
      title: 'Move your site to your own web app | CloudChef',
      description:
        'Leave the rented platform, keep what works, own the rest: CloudChef rebuilds a Shopify shop, WordPress site or other hosted site as your own web app in your own Cloudflare account.',
      path: '/move',
      imagePath: '/social-preview-home-v4.png',
      imageAlt: 'CloudChef — build and ship Cloudflare apps',
    }),
  component: () => <MovePage variant="move" />,
});
