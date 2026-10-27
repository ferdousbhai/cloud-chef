import { describe, expect, it } from 'vitest';
import { reviewDomainChange, type DomainReviewRead } from './cloudflare-domain-review';

const API = 'https://api.cloudflare.com/client/v4';
const DOMAINS = `${API}/accounts/acct/workers/domains`;

type Answer = [path: string, body: object];

function reads(answers: Answer[] = []): DomainReviewRead & { asked: string[] } {
  const asked: string[] = [];
  const read = async (path: string) => {
    asked.push(path);
    const body = answers.find(([answered]) => answered === path)?.[1];
    return body ? JSON.stringify(body) : null;
  };
  return Object.assign(read, { asked });
}

function attach(hostname: string, service: string, extra: { override_existing_dns_record?: boolean } = {}) {
  return { method: 'PUT' as const, url: DOMAINS, body: { hostname, service, zone_id: 'zone', ...extra } };
}

describe('reviewDomainChange', () => {
  it('leaves requests that touch no domain or route alone, without reading anything', async () => {
    const read = reads();
    const review = await reviewDomainChange(
      { method: 'POST', url: `${API}/accounts/acct/d1/database`, body: {} },
      read,
    );
    expect(review).toEqual({ warning: null });
    expect(read.asked).toEqual([]);
  });

  it("refuses to attach CloudChef's own address or one of its Workers", async () => {
    for (const request of [
      attach('cloudchef.build', 'my-site'),
      attach('www.cloudchef.build', 'my-site'),
      attach('alberta.ferdousbhai.com', 'cloudchef'),
      attach('alberta.ferdousbhai.com', 'CloudChef-user-runtime'),
    ]) {
      expect(await reviewDomainChange(request, reads())).toHaveProperty('refusal');
    }
  });

  it('says a new address will show the Worker, and that an address in use is refused by Cloudflare', async () => {
    const review = await reviewDomainChange(attach('alberta.ferdousbhai.com', 'alberta-plan-glossary'), reads());
    expect(review).toEqual({
      warning: expect.stringContaining('alberta.ferdousbhai.com will show the Worker alberta-plan-glossary'),
    });
  });

  it('says when approving moves an address away from the Worker it shows now', async () => {
    const read = reads([
      [
        '/accounts/acct/workers/domains?hostname=www.heston.io',
        { result: [{ hostname: 'www.heston.io', service: 'heston-site' }] },
      ],
    ]);
    const review = await reviewDomainChange(attach('www.heston.io', 'alberta-plan-glossary'), read);
    expect(review).toEqual({
      warning: expect.stringContaining('www.heston.io already shows the Worker heston-site'),
    });
  });

  it("refuses to move an address away from one of CloudChef's own Workers", async () => {
    const read = reads([
      [
        '/accounts/acct/workers/domains?hostname=app.example.com',
        { result: [{ hostname: 'app.example.com', service: 'cloudchef-preview' }] },
      ],
    ]);
    expect(await reviewDomainChange(attach('app.example.com', 'my-site'), read)).toHaveProperty('refusal');
  });

  it('warns when the request replaces an existing DNS record', async () => {
    const review = await reviewDomainChange(
      attach('blog.example.com', 'my-site', { override_existing_dns_record: true }),
      reads(),
    );
    expect(review).toEqual({ warning: expect.stringContaining('replaces blog.example.com’s DNS record') });
  });

  it('says what a removal takes away, and refuses removing one of CloudChef’s own', async () => {
    const path = '/accounts/acct/workers/domains/d1';
    const mine = await reviewDomainChange(
      { method: 'DELETE', url: `${API}${path}` },
      reads([[path, { result: { hostname: 'alberta.ferdousbhai.com', service: 'alberta-plan-glossary' } }]]),
    );
    expect(mine).toEqual({ warning: expect.stringContaining('alberta.ferdousbhai.com stops showing') });

    const own = await reviewDomainChange(
      { method: 'DELETE', url: `${API}${path}` },
      reads([[path, { result: { hostname: 'cloudchef.build', service: 'cloudchef' } }]]),
    );
    expect(own).toHaveProperty('refusal');
  });

  it("refuses routes onto CloudChef's address or Workers, and warns on any other route change", async () => {
    const routes = `${API}/zones/zone/workers/routes`;
    expect(
      await reviewDomainChange(
        { method: 'POST', url: routes, body: { pattern: '*cloudchef.build/*', script: 'x' } },
        reads(),
      ),
    ).toHaveProperty('refusal');
    expect(
      await reviewDomainChange(
        {
          method: 'PUT',
          url: `${API}/accounts/acct/workers/scripts/cloudchef/routes`,
          body: [{ pattern: 'a.example.com/*' }],
        },
        reads(),
      ),
    ).toHaveProperty('refusal');
    expect(
      await reviewDomainChange(
        { method: 'POST', url: routes, body: { pattern: 'shop.example.com/*', script: 'shop' } },
        reads(),
      ),
    ).toEqual({ warning: expect.stringContaining('shop.example.com/*') });
  });
});
