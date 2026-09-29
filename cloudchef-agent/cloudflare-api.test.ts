import { describe, expect, it } from 'vitest';
import {
  cloudflareApiRequestInputSchema,
  cloudflareApiRequestIsRead,
  CloudflareApiRequestRejectedError,
  normalizeCloudflareApiRequest,
} from './cloudflare-api.js';

const accountUrl = 'https://api.cloudflare.com/client/v4/accounts/account-1';

describe('normalizeCloudflareApiRequest', () => {
  it('accepts account, zone, and user requests on the public v4 API', () => {
    expect(
      normalizeCloudflareApiRequest({ method: 'GET', url: `${accountUrl}/d1/database?per_page=5` }, 'account-1'),
    ).toEqual({
      method: 'GET',
      url: `${accountUrl}/d1/database?per_page=5`,
    });
    expect(
      normalizeCloudflareApiRequest(
        {
          method: 'POST',
          url: 'https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache',
          body: { purge_everything: true },
        },
        'account-1',
      ),
    ).toMatchObject({ body: { purge_everything: true } });
    expect(
      normalizeCloudflareApiRequest({ method: 'GET', url: 'https://api.cloudflare.com/client/v4/user' }, 'account-1'),
    ).toBeTruthy();
  });

  it.each([
    ['another account', 'https://api.cloudflare.com/client/v4/accounts/account-2/workers/scripts'],
    ['a traversal to another account', `${accountUrl}/../account-2/workers/scripts`],
    ['an encoded traversal', `${accountUrl}/%2e%2e/account-2/workers/scripts`],
    ['another host', 'https://example.com/client/v4/accounts/account-1'],
    ['a lookalike host', 'https://api.cloudflare.com.example.com/client/v4/user'],
    ['plain http', 'http://api.cloudflare.com/client/v4/user'],
    ['credentials in the URL', 'https://user:pass@api.cloudflare.com/client/v4/user'],
    ['a path outside v4', 'https://api.cloudflare.com/client/v3/user'],
    ['a relative URL', '/client/v4/user'],
  ])('rejects %s', (_label, url) => {
    expect(() => normalizeCloudflareApiRequest({ method: 'GET', url }, 'account-1')).toThrow(
      CloudflareApiRequestRejectedError,
    );
  });

  it('accepts cf --dry-run output unchanged and folds its query into the URL', () => {
    expect(
      normalizeCloudflareApiRequest(
        {
          command: 'cf d1 list',
          method: 'GET',
          url: `${accountUrl}/d1/database`,
          pathParams: {},
          query: { name: 'foo', per_page: 5 },
          bodyKind: 'none',
        },
        'account-1',
      ),
    ).toEqual({ method: 'GET', url: `${accountUrl}/d1/database?name=foo&per_page=5` });
    expect(
      normalizeCloudflareApiRequest(
        {
          command: 'cf d1 query',
          method: 'POST',
          url: `${accountUrl}/d1/database/db-1/query`,
          pathParams: { 'database-id': 'db-1' },
          bodyKind: 'json',
          body: { sql: 'select 1' },
        },
        'account-1',
      ),
    ).toEqual({ method: 'POST', url: `${accountUrl}/d1/database/db-1/query`, body: { sql: 'select 1' } });
  });

  it('parses a body the model passed as a JSON string, but keeps a plain string', () => {
    const url = `${accountUrl}/storage/kv/namespaces`;
    expect(
      cloudflareApiRequestInputSchema.parse({ method: 'POST', url, body: '{"title": "cloudchef-approval-test"}' }),
    ).toEqual({ method: 'POST', url, body: { title: 'cloudchef-approval-test' } });
    expect(cloudflareApiRequestInputSchema.parse({ method: 'PUT', url, body: 'plain value' })).toEqual({
      method: 'PUT',
      url,
      body: 'plain value',
    });
  });

  it('rejects a non-JSON body kind', () => {
    expect(() =>
      normalizeCloudflareApiRequest({ method: 'PUT', url: accountUrl, bodyKind: 'multipart' }, 'account-1'),
    ).toThrow(CloudflareApiRequestRejectedError);
  });

  it('rejects a GET body and an oversized body', () => {
    expect(() => normalizeCloudflareApiRequest({ method: 'GET', url: accountUrl, body: {} }, 'account-1')).toThrow(
      CloudflareApiRequestRejectedError,
    );
    expect(() =>
      normalizeCloudflareApiRequest({ method: 'PUT', url: accountUrl, body: 'x'.repeat(61 * 1024) }, 'account-1'),
    ).toThrow(CloudflareApiRequestRejectedError);
  });

  it('treats only GET as a read', () => {
    expect(cloudflareApiRequestIsRead({ method: 'GET' })).toBe(true);
    expect(cloudflareApiRequestIsRead({ method: 'POST' })).toBe(false);
    expect(cloudflareApiRequestIsRead({ method: 'DELETE' })).toBe(false);
  });
});
