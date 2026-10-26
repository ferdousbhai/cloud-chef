import { describe, expect, it } from 'vitest';
import { siteAllowsFraming } from './site-framing';

const ORIGIN = 'https://cloudchef.build';

function answering(headers: Record<string, string>) {
  return async () => new Response('<html></html>', { headers });
}

describe('whether a site may be shown in a frame on the projects home', () => {
  it('follows frame-ancestors when the site sends one, as browsers do', async () => {
    const site = 'https://site.example.com/';
    expect(
      await siteAllowsFraming(site, ORIGIN, answering({ 'content-security-policy': "frame-ancestors 'none'" })),
    ).toBe(false);
    expect(
      await siteAllowsFraming(
        site,
        ORIGIN,
        answering({ 'content-security-policy': 'frame-ancestors https://cloudchef.build' }),
      ),
    ).toBe(true);
    expect(
      await siteAllowsFraming(site, ORIGIN, answering({ 'content-security-policy': "frame-ancestors 'self'" })),
    ).toBe(false);
    // frame-ancestors wins over X-Frame-Options.
    expect(
      await siteAllowsFraming(
        site,
        ORIGIN,
        answering({ 'content-security-policy': "base-uri 'self'; frame-ancestors *", 'x-frame-options': 'DENY' }),
      ),
    ).toBe(true);
  });

  it('falls back to X-Frame-Options, and allows a site that says nothing', async () => {
    const site = 'https://site.example.com/';
    expect(await siteAllowsFraming(site, ORIGIN, answering({ 'x-frame-options': 'DENY' }))).toBe(false);
    expect(await siteAllowsFraming(site, ORIGIN, answering({ 'x-frame-options': 'SAMEORIGIN' }))).toBe(false);
    expect(await siteAllowsFraming(site, ORIGIN, answering({}))).toBe(true);
  });

  it("doesn't know for a site that can't be reached", async () => {
    expect(
      await siteAllowsFraming('https://site.example.com/', ORIGIN, async () => {
        throw new TypeError('fetch failed');
      }),
    ).toBeNull();
  });
});
