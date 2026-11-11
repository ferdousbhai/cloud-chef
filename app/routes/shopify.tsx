import { createFileRoute } from '@tanstack/react-router';
import { MovePage } from '~/components/move/MovePage';
import { createSocialPageHead } from '~/lib/social-meta';

/** The same page as `/move`, opening on a Shopify shop: Shopify stays as the backend, and the storefront moves. */
export const Route = createFileRoute('/shopify')({
  head: () =>
    createSocialPageHead({
      title: 'A custom storefront for your Shopify shop | CloudChef',
      description:
        'Keep Shopify for products, checkout and payments, and own everything your customers see: CloudChef rebuilds your storefront as your own web app in your own Cloudflare account.',
      path: '/shopify',
      imagePath: '/social-preview-home-v4.png',
      imageAlt: 'CloudChef — build and ship Cloudflare apps',
    }),
  component: () => <MovePage variant="shopify" />,
});
