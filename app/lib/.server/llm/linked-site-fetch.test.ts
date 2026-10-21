import { describe, expect, it } from 'vitest';
import { fetchLinkedSitePage, htmlToText, SITE_FETCH_MAX_BYTES, SITE_FETCH_PAGE_CHARACTERS } from './linked-site-fetch';

const ORIGINS = ['https://example.com', 'https://abc-site.ada.workers.dev'];

/** A site answering from a table of paths, recording what was asked of it. */
function site(pages: Record<string, () => Response>) {
  const requests: { url: string; init: RequestInit }[] = [];
  return {
    requests,
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      const page = pages[url];
      return page ? page() : new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    },
  };
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

describe("reading a GitHub project's live site", () => {
  it("reads a page of the project's own site as text, by GET without following redirects blindly", async () => {
    const { fetch, requests } = site({
      'https://example.com/about': () =>
        html(
          '<html><head><title>About</title><style>h1{}</style><script>var secret = 1;</script></head>' +
            '<body><h1>Welcome &amp; hello</h1><p>We bake&nbsp;bread&#8212;daily.</p><!-- note --></body></html>',
        ),
    });
    const result = await fetchLinkedSitePage(
      { url: 'https://example.com/about' },
      { origins: async () => ORIGINS, fetch },
    );
    expect(result).toMatchObject({
      ok: true,
      data: { url: 'https://example.com/about', status: 200, contentType: 'text/html' },
      coverage: { complete: true, start: 0 },
    });
    expect(result.data).toMatchObject({ content: 'About\n\nWelcome & hello\n\nWe bake bread—daily.' });
    expect(requests).toEqual([
      { url: 'https://example.com/about', init: expect.objectContaining({ method: 'GET', redirect: 'manual' }) },
    ]);
  });

  it('returns the markup when asked, and JSON as served', async () => {
    const page = '<main><script id="data" type="application/json">{"intro":"Hi"}</script></main>';
    const { fetch } = site({
      'https://example.com/': () => html(page),
      'https://abc-site.ada.workers.dev/api/content?page=home': () => Response.json({ intro: 'Fresh bread' }),
    });
    const raw = await fetchLinkedSitePage(
      { url: 'https://example.com/', format: 'html' },
      { origins: async () => ORIGINS, fetch },
    );
    expect(raw.data).toMatchObject({ content: page });
    const stripped = await fetchLinkedSitePage(
      { url: 'https://example.com/' },
      { origins: async () => ORIGINS, fetch },
    );
    // Scripted copy disappears from text, so the result says where to look instead.
    expect(stripped.summary).toContain('try format html');
    const api = await fetchLinkedSitePage(
      { url: 'https://abc-site.ada.workers.dev/api/content?page=home', format: 'text' },
      { origins: async () => ORIGINS, fetch },
    );
    expect(api.data).toMatchObject({ contentType: 'application/json', content: '{"intro":"Fresh bread"}' });
  });

  it('reads nothing outside the sites GitHub reports, over plain http, or with credentials', async () => {
    const { fetch, requests } = site({});
    const elsewhere = await fetchLinkedSitePage(
      { url: 'https://evil.example.net/?q=secret' },
      { origins: async () => ORIGINS, fetch },
    );
    expect(elsewhere).toMatchObject({ ok: false, data: { origins: ORIGINS } });
    expect(elsewhere.summary).toContain('is not one of this project');
    // A sibling subdomain is another site.
    const sibling = await fetchLinkedSitePage(
      { url: 'https://other.ada.workers.dev/' },
      { origins: async () => ORIGINS, fetch },
    );
    expect(sibling.ok).toBe(false);
    for (const url of ['http://example.com/', 'https://user:pw@example.com/', 'example.com/about', 'not a url']) {
      expect((await fetchLinkedSitePage({ url }, { origins: async () => ORIGINS, fetch })).ok).toBe(false);
    }
    expect(requests).toEqual([]);
  });

  it('says what to do when no site is known, or the lookup fails', async () => {
    const { fetch } = site({});
    const none = await fetchLinkedSitePage({ url: 'https://example.com/' }, { origins: async () => [], fetch });
    expect(none).toMatchObject({ ok: false });
    expect(none.summary).toContain("set the repository's website on GitHub");
    const failed = await fetchLinkedSitePage(
      { url: 'https://example.com/' },
      {
        origins: async () => {
          throw new Error('This project is not available to you.');
        },
        fetch,
      },
    );
    expect(failed).toMatchObject({ ok: false, summary: 'This project is not available to you.' });
  });

  it("follows a redirect only within the project's sites", async () => {
    const { fetch, requests } = site({
      'https://example.com/old': () => new Response(null, { status: 301, headers: { location: '/new' } }),
      'https://example.com/new': () => html('<p>Moved here</p>'),
      'https://example.com/away': () =>
        new Response(null, { status: 302, headers: { location: 'https://tracker.example.org/x' } }),
      'https://example.com/loop': () => new Response(null, { status: 302, headers: { location: '/loop' } }),
    });
    const moved = await fetchLinkedSitePage(
      { url: 'https://example.com/old' },
      { origins: async () => ORIGINS, fetch },
    );
    expect(moved.data).toMatchObject({ url: 'https://example.com/new', content: 'Moved here' });
    const away = await fetchLinkedSitePage(
      { url: 'https://example.com/away' },
      { origins: async () => ORIGINS, fetch },
    );
    expect(away).toMatchObject({ ok: false });
    expect(requests.map((request) => request.url)).not.toContain('https://tracker.example.org/x');
    const loop = await fetchLinkedSitePage(
      { url: 'https://example.com/loop' },
      { origins: async () => ORIGINS, fetch },
    );
    expect(loop.summary).toContain('redirects too many times');
    expect(requests.filter((request) => request.url === 'https://example.com/loop')).toHaveLength(6);
  });

  it('refuses what is not text, and reports an error page as a failure with its body', async () => {
    const { fetch } = site({
      'https://example.com/logo.png': () =>
        new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }),
      'https://example.com/broken': () => html('<p>Server error</p>', 500),
    });
    const image = await fetchLinkedSitePage(
      { url: 'https://example.com/logo.png' },
      { origins: async () => ORIGINS, fetch },
    );
    expect(image).toMatchObject({ ok: false });
    expect(image.summary).toContain("image/png, which isn't text");
    const broken = await fetchLinkedSitePage(
      { url: 'https://example.com/broken' },
      { origins: async () => ORIGINS, fetch },
    );
    expect(broken).toMatchObject({ ok: false, data: { status: 500, content: 'Server error' } });
  });

  it('pages a long response and reads no more than its limit of a huge one', async () => {
    const long = 'a'.repeat(SITE_FETCH_PAGE_CHARACTERS + 10);
    const huge = 'b'.repeat(SITE_FETCH_MAX_BYTES + 5_000);
    const { fetch } = site({
      'https://example.com/long.txt': () => new Response(long, { headers: { 'content-type': 'text/plain' } }),
      'https://example.com/huge.txt': () => new Response(huge, { headers: { 'content-type': 'text/plain' } }),
      'https://example.com/exact.txt': () =>
        new Response('c'.repeat(SITE_FETCH_MAX_BYTES), { headers: { 'content-type': 'text/plain' } }),
    });
    const first = await fetchLinkedSitePage(
      { url: 'https://example.com/long.txt' },
      { origins: async () => ORIGINS, fetch },
    );
    expect(first.coverage).toEqual({
      complete: false,
      start: 0,
      end: SITE_FETCH_PAGE_CHARACTERS,
      total: long.length,
      nextCursor: String(SITE_FETCH_PAGE_CHARACTERS),
    });
    expect(first.summary).toContain(`continue with offset ${SITE_FETCH_PAGE_CHARACTERS}`);
    const rest = await fetchLinkedSitePage(
      { url: 'https://example.com/long.txt', offset: SITE_FETCH_PAGE_CHARACTERS },
      { origins: async () => ORIGINS, fetch },
    );
    expect(rest.data).toMatchObject({ content: 'a'.repeat(10) });
    expect(rest.coverage).toMatchObject({ complete: true, end: long.length });

    const cut = await fetchLinkedSitePage(
      { url: 'https://example.com/huge.txt', offset: SITE_FETCH_MAX_BYTES - 5 },
      { origins: async () => ORIGINS, fetch },
    );
    expect(cut.coverage).toMatchObject({ complete: false, total: SITE_FETCH_MAX_BYTES });
    expect(cut.summary).toContain('only its first 2 MB were read');
    const exact = await fetchLinkedSitePage(
      { url: 'https://example.com/exact.txt', offset: SITE_FETCH_MAX_BYTES },
      { origins: async () => ORIGINS, fetch },
    );
    expect(exact.coverage).toMatchObject({ complete: true, total: SITE_FETCH_MAX_BYTES });
  });

  it("gives up on a site that doesn't answer", async () => {
    const result = await fetchLinkedSitePage(
      { url: 'https://example.com/' },
      {
        origins: async () => ORIGINS,
        fetch: async () => {
          throw new TypeError('network');
        },
      },
    );
    expect(result).toMatchObject({ ok: false, summary: 'https://example.com/ did not answer.' });
  });
});

describe('an HTML page as text', () => {
  it('keeps one line per block, drops scripts, styles, comments and blank runs, and decodes entities', () => {
    expect(
      htmlToText(
        '<div>One</div>\n\n\n<div>Two<br>Three</div><svg><text>icon</text></svg><noscript>x</noscript>' +
          '<p>&lt;b&gt; &quot;q&quot; &#x41;&#66; &unknown; &#0;</p><ul><li>A</li><li>B</li></ul>',
      ),
    ).toBe('One\n\nTwo\nThree\n\n<b> "q" AB &unknown; &#0;\n\nA\n\nB');
  });
});
