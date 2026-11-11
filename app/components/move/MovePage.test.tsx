import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { MovePage, type MoveVariant } from './MovePage';

/** The page as the server sends it, before anyone's session is known. */
async function render(variant: MoveVariant): Promise<string> {
  const rootRoute = createRootRoute({ component: () => <MovePage variant={variant} /> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe('the page that sells moving a site in', () => {
  it('says what stays with Shopify, names the three sites, and promises nothing it cannot keep', async () => {
    const page = await render('move');
    expect(page).toContain('Leave the rented platform. Keep what works. Own the rest.');
    expect(page).toContain('You keep your Shopify plan.');
    expect(page).toContain('Shopify’s Storefront API');
    for (const address of [
      'https://saraadolfsen.com',
      'https://theforbiddenfeminine.com',
      'https://bohemiangoddess.com',
    ]) {
      expect(page).toContain(`href="${address}"`);
    }
    expect(page).toContain('In review');
    expect(page).toContain('not affiliated with');
    expect(page).toContain('href="#request-a-move"');
    // Bohemian Goddess is in review at an address that isn't public yet, and Shopify stays: neither may slip in.
    expect(page).not.toMatch(/workers\.dev|leave shopify|cancel|save on|\$\d|faster|self-serve|coming soon/i);
  });

  it('opens each address on its own platform and its own case study', async () => {
    const order = (page: string) =>
      ['saraadolfsen.com</h3>', 'The Forbidden Feminine</h3>', 'Bohemian Goddess</h3>'].sort(
        (a, b) => page.indexOf(a) - page.indexOf(b),
      )[0];
    const shopify = await render('shopify');
    expect(shopify).toContain('Keep Shopify behind the counter.');
    expect(order(shopify)).toBe('Bohemian Goddess</h3>');
    const wordpress = await render('wordpress');
    expect(wordpress).toContain('Move off WordPress.');
    expect(order(wordpress)).toBe('saraadolfsen.com</h3>');
    expect(order(await render('move'))).toBe('saraadolfsen.com</h3>');
  });
});
