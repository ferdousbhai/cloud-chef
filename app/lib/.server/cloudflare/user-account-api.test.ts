import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE } from './project-workspace-container-policy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { deploymentAssetHash, type DeploymentArtifactFile } from './deployment-artifact';
import { CloudflareAccountApiError, D1MigrationChangedError, UserCloudflareAccountApi } from './user-account-api';
import { USER_WORKSPACE_RUNTIME_GC_CRON } from './user-workspace-runtime-policy';

async function artifactFile(path: string, contents: string): Promise<DeploymentArtifactFile> {
  const bytes = new TextEncoder().encode(contents);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return {
    path,
    bytes,
    size: bytes.byteLength,
    sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

function currentAssetUploadJwt(): string {
  const claims = btoa(JSON.stringify({ wrangler_single_asset_uploads: true }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return `e30.${claims}.signature`;
}

/** The receipt table's columns, as PRAGMA table_info reports them once it has all of them. */
const RECEIPT_COLUMNS = [{ name: 'name' }, { name: 'applied_at' }, { name: 'digest' }, { name: 'sql' }];

async function textDigest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The account API, sending through `request` as the global fetch. */
function accountApi(accountId: string, token: string, request: typeof fetch, refresh?: () => Promise<string>) {
  vi.stubGlobal('fetch', request);
  return new UserCloudflareAccountApi(accountId, token, refresh);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UserCloudflareAccountApi', () => {
  test('reads the workspace Containers entitlement from the account capability endpoint', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: { limits: { total_vcpu: 1500 }, locations: [] } }));

    await expect(accountApi('account-1', 'user-token', request).readWorkspaceContainersEntitlement()).resolves.toEqual({
      status: 'entitled',
    });
    expect(request).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account-1/containers/me',
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        headers: expect.objectContaining({ authorization: 'Bearer user-token' }),
      }),
    );
  });

  test('reports the plan requirement and the upgrade destination Cloudflare names', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json(
        {
          error:
            'Unauthorized: You do not have access to Cloudflare Containers. Deploying containers requires the Workers Paid plan. Upgrade your plan at https://dash.cloudflare.com/?to=/:account/workers/plans',
        },
        { status: 401 },
      ),
    );

    await expect(accountApi('account-1', 'user-token', request).readWorkspaceContainersEntitlement()).resolves.toEqual({
      status: 'plan_required',
      message: expect.stringContaining('Workers Paid plan'),
      upgradeUrl: 'https://dash.cloudflare.com/?to=/:account/workers/plans',
    });
  });

  test('does not read a missing Containers scope as a missing plan', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: 'Unauthorized: Account is not authorized' }, { status: 401 }));

    await expect(accountApi('account-1', 'user-token', request).readWorkspaceContainersEntitlement()).resolves.toEqual({
      status: 'undetermined',
      // Nothing here classifies this wording yet, so the verdict carries the evidence to classify
      // it with once a real Workers Free account has produced one.
      reason:
        'Cloudflare refused the Containers capability check. status=401 codes=none wording="Unauthorized: Account is not authorized"',
    });
  });

  test('keeps credential-shaped text out of the refusal it records', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json(
        {
          error:
            'Refused for account 023e105f4ecef8ad9ca31a8372d0c353 (request 7f3a1c0b-4d2e-4a11-9f8e-2b6c5d4e3f21)\n' +
            'with Bearer v1.0-abcdefabcdef and ?api_key=supersecretvalue for ops@example.com',
        },
        { status: 401 },
      ),
    );

    const entitlement = await accountApi('account-1', 'user-token', request).readWorkspaceContainersEntitlement();

    expect(entitlement).toEqual({
      status: 'undetermined',
      reason: expect.stringContaining('status=401'),
    });
    const reason = entitlement.status === 'undetermined' ? entitlement.reason : '';
    for (const secret of [
      '023e105f4ecef8ad9ca31a8372d0c353',
      '7f3a1c0b-4d2e-4a11-9f8e-2b6c5d4e3f21',
      'v1.0-abcdefabcdef',
      'supersecretvalue',
      'ops@example.com',
    ]) {
      expect(reason).not.toContain(secret);
    }
    // One line, so the row it lands in stays one readable sentence in the operations report.
    expect(reason).not.toContain('\n');
  });

  test('leaves the Containers entitlement undetermined when Cloudflare cannot be reached', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('The connection was reset.'));

    await expect(accountApi('account-1', 'user-token', request).readWorkspaceContainersEntitlement()).resolves.toEqual({
      status: 'undetermined',
      reason: 'Cloudflare did not answer the Containers capability check: The connection was reset.',
    });
  });

  test('leaves the Containers entitlement undetermined when the account response is unreadable', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ success: true, result: {} }));

    await expect(accountApi('account-1', 'user-token', request).readWorkspaceContainersEntitlement()).resolves.toEqual({
      status: 'undetermined',
      reason: 'Cloudflare returned an unreadable Containers account response. status=200 codes=none wording=none',
    });
  });

  test('creates only the D1 name fixed by the approved plan in the connected account', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: [] }))
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { uuid: 'd1-id', name: 'cloudchef-deployment-1' } }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: { subdomain: 'user-subdomain' } }));
    const api = accountApi('account-1', 'user-token', request);

    await expect(api.ensureD1Database('cloudchef-deployment-1')).resolves.toEqual({
      id: 'd1-id',
      name: 'cloudchef-deployment-1',
    });
    await expect(api.getWorkersSubdomain()).resolves.toBe('user-subdomain');

    expect(request).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/accounts/account-1/d1/database',
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        body: JSON.stringify({ name: 'cloudchef-deployment-1' }),
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ authorization: 'Bearer user-token' }),
      }),
    );
    expect(request.mock.contexts).toEqual([undefined, undefined, undefined]);
  });

  test('fails closed instead of following a redirected Cloudflare API response', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: 'https://attacker.example/collect' },
      }),
    );

    await expect(
      accountApi('account-1', 'user-token', request).ensureD1Database('cloudchef-deployment-1'),
    ).rejects.toThrow('Cloudflare API request redirected unexpectedly.');
    expect(request).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account-1/d1/database?name=cloudchef-deployment-1',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  test('creates the protected D1 only under its independently approved plan name', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: [] }))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            uuid: 'agent-security-d1-id',
            name: 'cloudchef-deployment-1-agent-security',
          },
        }),
      );

    await expect(
      accountApi('account-1', 'token', request).ensureD1Database('cloudchef-deployment-1-agent-security'),
    ).resolves.toEqual({
      id: 'agent-security-d1-id',
      name: 'cloudchef-deployment-1-agent-security',
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/accounts/account-1/d1/database',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'cloudchef-deployment-1-agent-security' }),
      }),
    );
  });

  test('fails closed when Cloudflare returns a different resource', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: [] }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { uuid: 'd1-id', name: 'some-other-database' } }))
      // Looked for again in case another request created it meanwhile: still none.
      .mockResolvedValueOnce(Response.json({ success: true, result: [] }));
    await expect(
      accountApi('account-1', 'token', request).ensureD1Database('cloudchef-deployment-1'),
    ).rejects.toBeInstanceOf(CloudflareAccountApiError);
  });

  test('deletes managed Worker, D1, and KV resources idempotently by their approved names', async () => {
    const d1Id = '12345678-1234-1234-1234-123456789abc';
    const kvId = '0123456789abcdef0123456789abcdef';
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ uuid: d1Id, name: 'cloudchef-deployment-1' }] }))
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }))
      .mockResolvedValueOnce(
        Response.json({ success: true, result: [{ id: kvId, title: 'cloudchef-deployment-1-cache' }] }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const api = accountApi('account-1', 'token', request);

    await api.deleteManagedWorker('cloudchef-deployment-1');
    await api.deleteD1Database('cloudchef-deployment-1');
    await api.deleteKvNamespace('cloudchef-deployment-1-cache');

    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/cloudchef-deployment-1?force=true',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      `https://api.cloudflare.com/client/v4/accounts/account-1/d1/database/${d1Id}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(request).toHaveBeenNthCalledWith(
      5,
      `https://api.cloudflare.com/client/v4/accounts/account-1/storage/kv/namespaces/${kvId}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  test('empties R2 in bounded batches before deleting the bucket', async () => {
    const bucket = 'cloudchef-deployment-1-storage';
    const present = () => Response.json({ success: true, result: { name: bucket } });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(present())
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }))
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }))
      .mockResolvedValueOnce(
        Response.json({ success: true, result: [{ key: '../retained.txt' }, { key: 'folder/a file?.txt' }] }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: { key: 'folder/a file?.txt' } }))
      .mockResolvedValueOnce(present())
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }))
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = accountApi('account-1', 'token', request);

    await expect(api.deleteR2Bucket(bucket)).resolves.toBe(false);
    await expect(api.deleteR2Bucket(bucket)).resolves.toBe(true);

    expect(request).toHaveBeenNthCalledWith(
      5,
      `https://api.cloudflare.com/client/v4/accounts/account-1/r2/buckets/${bucket}/objects/folder/a%20file%3F.txt`,
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(request).not.toHaveBeenCalledWith(expect.stringContaining('/objects/%2E%2E/'), expect.anything());
    expect(request).toHaveBeenNthCalledWith(
      3,
      `https://api.cloudflare.com/client/v4/accounts/account-1/r2/buckets/${bucket}/lifecycle`,
      expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('cloudchef-project-deletion'),
      }),
    );
    expect(request).toHaveBeenLastCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/account-1/r2/buckets/${bucket}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  test('reuses already provisioned plan resources after an interrupted deployment', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ success: true, result: [{ uuid: 'existing-d1', name: 'cloudchef-deployment-1' }] }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: { name: 'cloudchef-deployment-1-storage' } }));
    const api = accountApi('account-1', 'token', request);
    await expect(api.ensureD1Database('cloudchef-deployment-1')).resolves.toEqual({
      id: 'existing-d1',
      name: 'cloudchef-deployment-1',
    });
    await expect(api.ensureR2Bucket('cloudchef-deployment-1-storage')).resolves.toEqual({
      id: 'cloudchef-deployment-1-storage',
      name: 'cloudchef-deployment-1-storage',
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
  });

  test('provisions the preview bucket and namespace under their own plan names', async () => {
    const namespaceId = 'abcdef0123456789abcdef0123456789';
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { name: 'cloudchef-deployment-1-preview-storage' } }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [
            { id: '0123456789abcdef0123456789abcdef', title: 'cloudchef-deployment-1-cache' },
            { id: namespaceId, title: 'cloudchef-deployment-1-preview-cache' },
          ],
        }),
      );
    const api = accountApi('account-1', 'token', request);

    await expect(api.ensureR2Bucket('cloudchef-deployment-1-preview-storage')).resolves.toEqual({
      id: 'cloudchef-deployment-1-preview-storage',
      name: 'cloudchef-deployment-1-preview-storage',
    });
    await expect(api.ensureKvNamespace('cloudchef-deployment-1-preview-cache')).resolves.toEqual({
      id: namespaceId,
      name: 'cloudchef-deployment-1-preview-cache',
    });
    expect(String(request.mock.calls[0]?.[0])).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account-1/r2/buckets/cloudchef-deployment-1-preview-storage',
    );
  });

  test('creates only the KV namespace fixed by the approved plan', async () => {
    const namespaceId = '0123456789abcdef0123456789abcdef';
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: [] }))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: { id: namespaceId, title: 'cloudchef-deployment-1-cache' },
        }),
      );

    await expect(
      accountApi('account-1', 'token', request).ensureKvNamespace('cloudchef-deployment-1-cache'),
    ).resolves.toEqual({
      id: namespaceId,
      name: 'cloudchef-deployment-1-cache',
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://api.cloudflare.com/client/v4/accounts/account-1/storage/kv/namespaces?page=1&per_page=1000',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/accounts/account-1/storage/kv/namespaces',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'cloudchef-deployment-1-cache' }),
      }),
    );
  });

  test('rejects a matching D1 readback without an identity instead of creating a replacement', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ name: 'cloudchef-deployment-1' }] }));

    await expect(accountApi('account-1', 'token', request).ensureD1Database('cloudchef-deployment-1')).rejects.toThrow(
      'invalid D1 resource',
    );
    expect(request).toHaveBeenCalledOnce();
  });

  test('accepts a bucket concurrently created after its create request loses the race', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: false }, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ success: false, errors: [{ message: 'bucket already exists' }] }, { status: 409 }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: { name: 'cloudchef-user-data' } }));
    const api = accountApi('account-1', 'token', request);

    await expect(api.ensureR2Bucket('cloudchef-user-data')).resolves.toEqual({
      id: 'cloudchef-user-data',
      name: 'cloudchef-user-data',
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  test('rejects malformed R2 readback instead of creating a replacement bucket', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ success: true, result: {} }));

    await expect(
      accountApi('account-1', 'token', request).ensureR2Bucket('cloudchef-deployment-1-storage'),
    ).rejects.toThrow('invalid R2 resource');
    expect(request).toHaveBeenCalledOnce();
  });

  test('does not leak the connected token through provider errors', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ success: false, errors: [{ message: 'permission denied' }] }, { status: 403 }),
      );
    await expect(
      accountApi('account-1', 'secret-token', request).ensureD1Database('cloudchef-deployment-1'),
    ).rejects.toThrow('permission denied');
  });

  test('rejects a D1 response when any statement reports failure', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        success: true,
        result: [
          { success: true, results: [] },
          { success: false, results: [] },
        ],
      }),
    );

    await expect(
      accountApi('account-1', 'token', request).applyD1Migrations('0123456789abcdef0123456789abcdef', []),
    ).rejects.toThrow('unsuccessful D1 query result');
  });

  test.each([{}, [], [{ success: true, results: {} }]])('rejects malformed D1 query result %#', async (result) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, result }));

    await expect(
      accountApi('account-1', 'token', request).applyD1Migrations('0123456789abcdef0123456789abcdef', []),
    ).rejects.toThrow('unsuccessful D1 query result');
  });

  test('applies each migration and its marker in one transactional D1 batch', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: [] }] }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: RECEIPT_COLUMNS }] }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: [] }] }))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [
            { success: true, results: [] },
            { success: true, results: [] },
          ],
        }),
      );
    const api = accountApi('account-1', 'token', request);

    await api.applyD1Migrations('0123456789abcdef0123456789abcdef', [
      { name: '0001_users.sql', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY)' },
    ]);

    const batch = JSON.parse(String(request.mock.calls[3]?.[1]?.body)) as { batch: Array<{ sql: string }> };
    expect(batch.batch).toHaveLength(2);
    expect(batch.batch[0]?.sql).toBe('CREATE TABLE users (id TEXT PRIMARY KEY)');
    expect(batch.batch[1]?.sql).toContain('cloudchef_runtime_migrations');
    expect(batch.batch[1]?.sql).toContain('digest');
    expect(batch.batch[1]?.sql).not.toContain('OR IGNORE');
    // The receipt keeps what was applied, so a refusal can quote it.
    expect(JSON.parse(String(request.mock.calls[3]?.[1]?.body)).batch[1].params).toContain(
      'CREATE TABLE users (id TEXT PRIMARY KEY)',
    );
  });

  test('reads every migration receipt in one request', async () => {
    // This runs on every runtime upgrade for every connected account, and the answer there is
    // always "already applied". One receipt read per migration turned that no-op into a serial
    // walk of the Cloudflare D1 API.
    const migrations = await Promise.all(
      ['0001_a.sql', '0002_b.sql', '0003_c.sql'].map(async (name) => {
        const sql = `CREATE TABLE ${name.slice(5, -4)} (id TEXT PRIMARY KEY)`;
        return { name, sql, digest: await textDigest(sql) };
      }),
    );
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: [] }] }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: RECEIPT_COLUMNS }] }))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [
            {
              success: true,
              results: migrations.map(({ name, digest }) => ({ name, digest })),
            },
          ],
        }),
      );

    await accountApi('account-1', 'token', request).applyD1Migrations(
      '0123456789abcdef0123456789abcdef',
      migrations.map(({ name, sql }) => ({ name, sql })),
    );

    // Create table, digest-column pragma, one receipt read. Nothing per migration.
    expect(request).toHaveBeenCalledTimes(3);
    expect(String(request.mock.calls[2]?.[1]?.body)).not.toContain('WHERE name');
  });

  test('resolves an ambiguous D1 batch acknowledgement by reading the transactional marker', async () => {
    const sql = 'ALTER TABLE users ADD COLUMN display_name TEXT';
    const digest = await textDigest(sql);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: [] }] }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: RECEIPT_COLUMNS }] }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: [] }] }))
      .mockRejectedValueOnce(new Error('network acknowledgement lost'))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [{ success: true, results: [{ name: '0001_users.sql', digest }] }],
        }),
      );
    const api = accountApi('account-1', 'token', request);

    await expect(
      api.applyD1Migrations('0123456789abcdef0123456789abcdef', [{ name: '0001_users.sql', sql }]),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(5);
  });

  test('rejects a concurrent migration that records a different digest', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: [] }] }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: RECEIPT_COLUMNS }] }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: [] }] }))
      .mockRejectedValueOnce(new Error('UNIQUE constraint failed: cloudchef_runtime_migrations.name'))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [{ success: true, results: [{ name: '0001_users.sql', digest: 'b'.repeat(64) }] }],
        }),
      );

    await expect(
      accountApi('account-1', 'token', request).applyD1Migrations('0123456789abcdef0123456789abcdef', [
        { name: '0001_users.sql', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY)' },
      ]),
    ).rejects.toThrow('migration digest mismatch');
  });

  test('rejects an applied migration whose recorded digest differs', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: [] }] }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ success: true, results: RECEIPT_COLUMNS }] }))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [{ success: true, results: [{ name: '0001_users.sql', digest: 'b'.repeat(64) }] }],
        }),
      );

    await expect(
      accountApi('account-1', 'token', request).applyD1Migrations('0123456789abcdef0123456789abcdef', [
        { name: '0001_users.sql', sql: 'CREATE TABLE users (id TEXT PRIMARY KEY)' },
      ]),
    ).rejects.toMatchObject({ message: expect.stringContaining('migration digest mismatch'), appliedSql: null });
    // Create table, column pragma, receipts, and the applied SQL it failed to read: nothing is applied.
    expect(request).toHaveBeenCalledTimes(4);
    expect(String(request.mock.calls[3]?.[1]?.body)).toContain('SELECT sql FROM cloudchef_runtime_migrations');
  });

  test('replaces runtime schedules with exactly one deterministic GC trigger, and reads them back', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        success: true,
        result: {
          schedules: [
            {
              cron: USER_WORKSPACE_RUNTIME_GC_CRON,
              created_on: '2026-08-04T10:00:00Z',
              modified_on: '2026-08-04T10:00:00Z',
            },
          ],
        },
      }),
    );

    await expect(
      accountApi('account-1', 'token', request).configureWorkspaceRuntimeGcSchedule('cloudchef-workspace-1'),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/cloudchef-workspace-1/schedules',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify([{ cron: '*/15 * * * *' }]),
        headers: expect.objectContaining({
          authorization: 'Bearer token',
          'content-type': 'application/json',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(['PUT', 'GET']);
  });

  test.each([
    ['missing schedule collection', {}],
    ['no schedule', { schedules: [] }],
    ['an additional schedule', { schedules: [{ cron: USER_WORKSPACE_RUNTIME_GC_CRON }, { cron: '0 0 * * *' }] }],
    ['a changed schedule', { schedules: [{ cron: '0 0 * * *' }] }],
  ])('rejects schedule readback with %s', async (_label, result) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, result }));

    await expect(
      accountApi('account-1', 'token', request).configureWorkspaceRuntimeGcSchedule('cloudchef-workspace-1'),
    ).rejects.toThrow('invalid Worker schedules');

    expect(request).toHaveBeenCalledOnce();
  });

  test('rejects an unsuccessful schedule update envelope', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        success: false,
        errors: [{ code: 1000, message: 'schedule update rejected' }],
        result: { schedules: [{ cron: USER_WORKSPACE_RUNTIME_GC_CRON }] },
      }),
    );

    await expect(
      accountApi('account-1', 'token', request).configureWorkspaceRuntimeGcSchedule('cloudchef-workspace-1'),
    ).rejects.toThrow('schedule update rejected');

    expect(request).toHaveBeenCalledOnce();
  });

  test('creates a Worker with assets and reads back the exact active version', async () => {
    const module = await artifactFile('index.js', 'export default { fetch() { return new Response("ok") } }');
    const asset = await artifactFile('index.html', '<h1>CloudChef</h1>');
    const duplicateAsset = await artifactFile('nested/index.html', '<h1>CloudChef</h1>');
    const assetHash = await deploymentAssetHash(asset);
    const sessionJwt = currentAssetUploadJwt();
    const workerVersionId = '11111111-1111-4111-8111-111111111111';
    const providerDeploymentId = '22222222-2222-4222-8222-222222222222';
    const versions = [{ percentage: 100, version_id: workerVersionId }];
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: { jwt: sessionJwt, buckets: [[assetHash]] } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { jwt: 'asset-completion-jwt' } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: 'cloudchef-app', etag: 'managed-etag' } }))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: { deployments: [{ id: providerDeploymentId, created_on: '2026-07-21T00:00:00Z', versions }] },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: { id: workerVersionId, resources: { script: { etag: 'managed-etag' } } },
        }),
      );
    const api = accountApi('account-1', 'oauth-token', request);

    await expect(
      api.deployManagedWorker({
        workerName: 'cloudchef-app',
        projectType: 'web_app',
        sourceSha256: 'a'.repeat(64),
        mainModule: 'index.js',
        modules: [module],
        assets: [asset, duplicateAsset],
        workerFirstAssets: true,
        workersAi: true,
        appAgent: true,
        d1DatabaseId: '0123456789abcdef0123456789abcdef',
        agentSecurityD1DatabaseId: 'abcdef0123456789abcdef0123456789',
        r2BucketName: 'cloudchef-storage',
        kvNamespaceId: '0123456789abcdef0123456789abcdef',
      }),
    ).resolves.toEqual({ workerVersionId });

    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/cloudchef-app/assets-upload-session',
      `https://api.cloudflare.com/client/v4/accounts/account-1/workers/assets/upload/${assetHash}`,
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/cloudchef-app?excludeScript=true&bindings_inherit=strict',
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/cloudchef-app/deployments',
      `https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/cloudchef-app/versions/${workerVersionId}`,
    ]);
    expect(request.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      manifest: {
        '/index.html': { hash: assetHash, size: asset.size },
        '/nested/index.html': { hash: assetHash, size: duplicateAsset.size },
      },
    });
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${sessionJwt}`,
      'content-type': 'text/html',
    });
    expect(new Uint8Array(request.mock.calls[1]?.[1]?.body as ArrayBuffer)).toEqual(asset.bytes);
    const workerForm = request.mock.calls[2]?.[1]?.body as FormData;
    // A Durable Object class only comes into being through a deployment, so an AppAgent project
    // never takes the version-then-promote path.
    expect(request.mock.calls[2]?.[1]?.method).toBe('PUT');
    const metadata = JSON.parse(await (workerForm.get('metadata') as Blob).text()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      main_module: 'index.js',
      assets: { jwt: 'asset-completion-jwt', config: { run_worker_first: ['/*', '!/assets/*'] } },
      compatibility_date: '2026-07-21',
      bindings: expect.arrayContaining([
        { type: 'assets', name: 'ASSETS' },
        {
          type: 'kv_namespace',
          name: 'APP_CACHE',
          namespace_id: '0123456789abcdef0123456789abcdef',
        },
      ]),
    });
    expect(JSON.stringify(metadata)).not.toMatch(/oauth-token|CLOUDFLARE_API_TOKEN|apiToken/);
    expect(workerForm.get('index.js')).toBeInstanceOf(Blob);
  });

  test('promotes an immutable version when a plain Worker already exists', async () => {
    const module = await artifactFile('index.js', 'export default { fetch() { return new Response("ok") } }');
    const workerVersionId = '22222222-2222-4222-8222-222222222222';
    const providerDeploymentId = '33333333-3333-4333-8333-333333333333';
    const versions = [{ percentage: 100, version_id: workerVersionId }];
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            deployments: [
              {
                id: 'previous-deployment',
                created_on: '2026-07-21T00:00:00Z',
                versions: [{ percentage: 100, version_id: '00000000-0000-4000-8000-000000000000' }],
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: workerVersionId } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: providerDeploymentId, versions } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: providerDeploymentId, versions } }));

    await expect(
      accountApi('account-1', 'token', request).deployManagedWorker({
        workerName: 'cloudchef-worker',
        projectType: 'worker',
        sourceSha256: 'a'.repeat(64),
        mainModule: 'index.js',
        modules: [module],
        assets: [],
        workerFirstAssets: false,
        workersAi: false,
        appAgent: false,
      }),
    ).resolves.toEqual({ workerVersionId });

    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/cloudchef-worker/deployments',
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/cloudchef-worker/versions',
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/cloudchef-worker/deployments',
      `https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/cloudchef-worker/deployments/${providerDeploymentId}`,
    ]);
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST', 'POST', 'GET']);
  });

  test('publishes a never-deployed plain Worker directly instead of uploading a version', async () => {
    const module = await artifactFile('index.js', 'export default { fetch() { return new Response("ok") } }');
    const workerVersionId = '22222222-2222-4222-8222-222222222222';
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, errors: [{ code: 10007 }] }), { status: 404 }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: 'cloudchef-worker', etag: 'managed-etag' } }))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            deployments: [
              {
                id: 'first-deployment',
                created_on: '2026-07-21T00:00:00Z',
                versions: [{ percentage: 100, version_id: workerVersionId }],
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: { id: workerVersionId, resources: { script: { etag: 'managed-etag' } } },
        }),
      );

    await expect(
      accountApi('account-1', 'token', request).deployManagedWorker({
        workerName: 'cloudchef-worker',
        projectType: 'worker',
        sourceSha256: 'a'.repeat(64),
        mainModule: 'index.js',
        modules: [module],
        assets: [],
        workerFirstAssets: false,
        workersAi: false,
        appAgent: false,
      }),
    ).resolves.toEqual({ workerVersionId });

    expect(request.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
      'GET https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/cloudchef-worker/deployments',
      'PUT https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/cloudchef-worker?excludeScript=true&bindings_inherit=strict',
      'GET https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/cloudchef-worker/deployments',
      `GET https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/cloudchef-worker/versions/${workerVersionId}`,
    ]);
  });

  test('rejects unknown asset bucket hashes and a missing final completion JWT', async () => {
    const module = await artifactFile('index.js', 'export default {}');
    const asset = await artifactFile('index.html', '<h1>CloudChef</h1>');
    const deploy = (request: typeof fetch) =>
      accountApi('account-1', 'token', request).deployManagedWorker({
        workerName: 'cloudchef-app',
        projectType: 'web_app',
        sourceSha256: 'a'.repeat(64),
        mainModule: 'index.js',
        modules: [module],
        assets: [asset],
        workerFirstAssets: false,
        workersAi: false,
        appAgent: false,
      });
    const unknownBucket = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { jwt: currentAssetUploadJwt(), buckets: [['f'.repeat(32)]] } }),
      );
    await expect(deploy(unknownBucket)).rejects.toThrow('unknown managed Worker asset');
    expect(unknownBucket).toHaveBeenCalledOnce();

    const assetHash = await deploymentAssetHash(asset);
    const missingCompletion = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { jwt: currentAssetUploadJwt(), buckets: [[assetHash]] } }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }, { status: 201 }));
    await expect(deploy(missingCompletion)).rejects.toThrow('invalid asset upload identity');
    expect(missingCompletion).toHaveBeenCalledTimes(2);

    // A session identity without the single-asset claim selects the batched multipart
    // protocol, exactly as wrangler does; the observed 2026-08-19 production outage was this
    // claim disappearing while only the per-file protocol was implemented.
    const batchedSession = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { jwt: 'e30.e30.signature', buckets: [[assetHash]] } }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }, { status: 201 }));
    await expect(deploy(batchedSession)).rejects.toThrow('invalid asset upload identity');
    expect(batchedSession).toHaveBeenCalledTimes(2);
    const [batchUrl, batchInit] = batchedSession.mock.calls[1] ?? [];
    expect(String(batchUrl)).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/assets/upload?base64=true',
    );
    expect(batchInit?.method).toBe('POST');
    const form = batchInit?.body;
    if (!(form instanceof FormData)) {
      throw new Error('The batched upload must carry a multipart form body.');
    }
    const part = form.get(assetHash);
    if (!(part instanceof File)) {
      throw new Error('The batched upload must key each file part by its content hash.');
    }
    expect(part.name).toBe(assetHash);
    expect(part.type).toContain('text/html');
    expect(await part.text()).toBe(btoa('<h1>CloudChef</h1>'));
  });

  test('forces one credential refresh and retries exactly once on a Cloudflare 401', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: false }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { subdomain: 'fresh-subdomain' } }));
    const refreshAccessToken = vi.fn(async () => 'fresh-token');
    const api = accountApi('account-1', 'expired-token', request, refreshAccessToken);

    await expect(api.getWorkersSubdomain()).resolves.toBe('fresh-subdomain');
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer expired-token' });
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: 'Bearer fresh-token' });
  });

  test('does not loop when Cloudflare rejects the forced-refresh retry', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: false }, { status: 401 }));
    const refreshAccessToken = vi.fn(async () => 'fresh-token');
    const api = accountApi('account-1', 'expired-token', request, refreshAccessToken);

    await expect(api.getWorkersSubdomain()).rejects.toThrow('Cloudflare API request failed (401)');
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('reads back the exact managed schedule and public subdomain state', async () => {
    const schedule = { schedules: [{ cron: '0 3 * * *' }] };
    const subdomain = { enabled: true, previews_enabled: false };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: schedule }))
      .mockResolvedValueOnce(Response.json({ success: true, result: schedule }))
      .mockResolvedValueOnce(Response.json({ success: true, result: subdomain }))
      .mockResolvedValueOnce(Response.json({ success: true, result: subdomain }));
    const api = accountApi('account-1', 'token', request);

    await expect(api.configureManagedWorkerSchedule('cloudchef-app', true)).resolves.toBeUndefined();
    await expect(api.enableWorkerSubdomain('cloudchef-app')).resolves.toBeUndefined();
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(['PUT', 'GET', 'POST', 'GET']);
    // Only the active version is served: an earlier one, bound to the data it shipped with, is not.
    expect(JSON.parse(String(request.mock.calls[2]?.[1]?.body))).toEqual({ enabled: true, previews_enabled: false });
  });

  test('reads the Durable Object classes Cloudflare holds for one Worker, across every page', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [
            { id: 'a'.repeat(32), class: 'AppAgent', script: 'cloudchef-app' },
            { id: 'b'.repeat(32), class: 'AppAgent', script: 'cloudchef-app-preview' },
          ],
          result_info: { total_pages: 2 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [
            { id: 'c'.repeat(32), class: 'ProjectWorkspace', script: 'cloudchef-workspace' },
            { id: 'd'.repeat(32), class: 'Other', script: 'cloudchef-app' },
          ],
          result_info: { total_pages: 2 },
        }),
      );

    await expect(
      accountApi('account-1', 'token', request).managedWorkerDurableObjectClasses('cloudchef-app'),
    ).resolves.toEqual(['AppAgent', 'Other']);
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/durable_objects/namespaces?page=1&per_page=1000',
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/durable_objects/namespaces?page=2&per_page=1000',
    ]);
  });

  test('refuses a Worker that still serves its versions at preview URLs', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: { enabled: true, previews_enabled: false } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { enabled: true, previews_enabled: true } }));

    await expect(accountApi('account-1', 'token', request).enableWorkerSubdomain('cloudchef-app')).rejects.toThrow(
      'invalid managed Worker subdomain state',
    );
  });

  test('rejects missing schedule readback when the expected schedule set is empty', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }))
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }));

    await expect(
      accountApi('account-1', 'token', request).configureManagedWorkerSchedule('cloudchef-app', false),
    ).rejects.toThrow('invalid Worker schedules');
  });

  test('deploys the Computer workspace and execution bindings into the user account', async () => {
    const workerVersionId = '33333333-3333-4333-8333-333333333333';
    const providerDeploymentId = '44444444-4444-4444-8444-444444444444';
    const versions = [{ percentage: 100, version_id: workerVersionId }];
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { id: 'cloudchef-workspace-user', etag: 'runtime-etag' } }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            deployments: [{ id: providerDeploymentId, created_on: '2026-07-27T00:00:00Z', versions }],
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: { id: workerVersionId, resources: { script: { etag: 'runtime-etag' } } },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [
            {
              id: '0123456789abcdef0123456789abcdef',
              class: 'ProjectWorkspace',
              script: 'cloudchef-workspace-user',
              use_sqlite: true,
            },
          ],
        }),
      );
    const api = accountApi('user-account', 'user-token', request);

    await expect(
      api.deployWorkspaceRuntimeWorker({
        workerName: 'cloudchef-workspace-user',
        source: 'export default { fetch() { return new Response() } }',
        controlPlaneSecret: 'control-plane-secret-that-is-long-enough',
        runtimeVersion: 'a'.repeat(64),
        databaseId: '0123456789abcdef0123456789abcdef',
        userId: 'user-1',
        connectionId: 'connection-1',
        connectionGeneration: 1,
        sharedAccount: false,
        endpoint: 'https://cloudchef-workspace-user.example.workers.dev',
      }),
    ).resolves.toEqual({ namespaceId: '0123456789abcdef0123456789abcdef' });

    const [scriptUrl, scriptInit] = request.mock.calls[0];
    expect(scriptUrl).toBe(
      'https://api.cloudflare.com/client/v4/accounts/user-account/workers/scripts/cloudchef-workspace-user?excludeScript=true&bindings_inherit=strict',
    );
    expect(scriptInit).toMatchObject({ method: 'PUT', headers: { authorization: 'Bearer user-token' } });
    const form = scriptInit?.body as FormData;
    const metadataPart = form.get('metadata');
    expect(metadataPart).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataPart as Blob).text()) as {
      bindings: Array<Record<string, string>>;
      compatibility_flags: string[];
      containers: Array<{ class_name: string }>;
      exports: Record<string, unknown>;
      observability: unknown;
    };
    expect(metadata.compatibility_flags).toEqual(['nodejs_compat']);
    expect(metadata.containers).toEqual([{ class_name: 'ProjectWorkspace' }]);
    expect(metadata.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'durable_object_namespace',
          name: 'PROJECT_WORKSPACE',
          class_name: 'ProjectWorkspace',
        }),
        expect.objectContaining({
          type: 'plain_text',
          name: 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT',
          text: 'https://cloudchef.build',
        }),
      ]),
    );
    expect(metadata.bindings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'SANDBOX_TRANSPORT' })]),
    );
    expect(metadata.bindings).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'worker_loader' })]));
    expect(metadata.bindings).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'r2_bucket' })]));
    expect(metadata.bindings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'CLOUDFLARE_API_TOKEN' })]),
    );
    expect(metadata.exports).toMatchObject({
      ProjectWorkspace: { type: 'durable-object', storage: 'sqlite' },
      BuilderAgent: { type: 'durable-object', storage: 'sqlite' },
    });
    expect(metadata.exports.ProjectWorkspace).not.toHaveProperty('container');
    expect(metadata.observability).toEqual({
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 0.6 },
    });
  });

  test('creates the Sandbox container application in the user account', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(
        Response.json({
          id: 'container-application-1',
          name: 'cloudchef-workspace-user',
          durable_objects: { namespace_id: '0123456789abcdef0123456789abcdef' },
        }),
      );
    const api = accountApi('user-account', 'user-token', request);
    const image = `docker.io/cloudflare/sandbox:0.12.4@sha256:${'b'.repeat(64)}`;

    await expect(
      api.ensureWorkspaceRuntimeContainer({
        applicationName: 'cloudchef-workspace-user',
        namespaceId: '0123456789abcdef0123456789abcdef',
        image,
      }),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://api.cloudflare.com/client/v4/accounts/user-account/containers/applications',
      expect.objectContaining({ method: 'GET' }),
    );
    const [, createInit] = request.mock.calls[1];
    const createPayload = JSON.parse(String(createInit?.body));
    expect(createPayload).toMatchObject({
      name: 'cloudchef-workspace-user',
      configuration: {
        image,
        instance_type: PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE,
        wrangler_ssh: { enabled: false },
      },
      max_instances: 10,
      durable_objects: { namespace_id: '0123456789abcdef0123456789abcdef' },
    });
  });

  test('rolls out a new Sandbox image for an existing container application', async () => {
    const image = `docker.io/cloudflare/sandbox:0.12.5@sha256:${'b'.repeat(64)}`;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 'container-application-1',
            name: 'cloudchef-workspace-user',
            durable_objects: { namespace_id: '0123456789abcdef0123456789abcdef' },
          },
        ]),
      )
      .mockResolvedValueOnce(Response.json({ id: 'container-application-1', name: 'cloudchef-workspace-user' }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ id: 'rollout-1' }))
      .mockResolvedValueOnce(
        Response.json({
          id: 'rollout-1',
          created_at: '2026-08-05T00:00:00Z',
          status: 'completed',
          target_configuration: {
            image,
            instance_type: PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE,
            observability: { logs: { enabled: true } },
            wrangler_ssh: { enabled: false },
          },
        }),
      );

    await accountApi('user-account', 'user-token', request).ensureWorkspaceRuntimeContainer({
      applicationName: 'cloudchef-workspace-user',
      namespaceId: '0123456789abcdef0123456789abcdef',
      image,
    });

    expect(request).toHaveBeenNthCalledWith(
      4,
      'https://api.cloudflare.com/client/v4/accounts/user-account/containers/applications/container-application-1/rollouts',
      expect.objectContaining({ method: 'POST' }),
    );
    const rollout = JSON.parse(String(request.mock.calls[3]?.[1]?.body));
    expect(rollout).toMatchObject({
      strategy: 'rolling',
      step_percentage: 100,
      kind: 'full_auto',
      target_configuration: { image },
    });
  });

  test('reuses a matching active Sandbox rollout', async () => {
    const image = `docker.io/cloudflare/sandbox:0.12.5@sha256:${'b'.repeat(64)}`;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 'container-application-1',
            name: 'cloudchef-workspace-user',
            durable_objects: { namespace_id: '0123456789abcdef0123456789abcdef' },
          },
        ]),
      )
      .mockResolvedValueOnce(Response.json({ id: 'container-application-1', name: 'cloudchef-workspace-user' }))
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 'rollout-1',
            created_at: '2026-08-05T00:00:00Z',
            status: 'progressing',
            target_configuration: {
              image,
              instance_type: PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE,
              observability: { logs: { enabled: true } },
              wrangler_ssh: { enabled: false },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 'rollout-1',
          created_at: '2026-08-05T00:00:00Z',
          status: 'completed',
          target_configuration: {
            image,
            instance_type: PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE,
            observability: { logs: { enabled: true } },
            wrangler_ssh: { enabled: false },
          },
        }),
      );

    await accountApi('user-account', 'user-token', request).ensureWorkspaceRuntimeContainer({
      applicationName: 'cloudchef-workspace-user',
      namespaceId: '0123456789abcdef0123456789abcdef',
      image,
    });

    expect(request).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenLastCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/user-account/containers/applications/container-application-1/rollouts/rollout-1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('waits for a matching Sandbox rollout to complete', async () => {
    const image = `docker.io/cloudflare/sandbox:0.12.5@sha256:${'b'.repeat(64)}`;
    const targetConfiguration = {
      image,
      instance_type: PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE,
      observability: { logs: { enabled: true } },
      wrangler_ssh: { enabled: false },
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 'container-application-1',
            name: 'cloudchef-workspace-user',
            durable_objects: { namespace_id: '0123456789abcdef0123456789abcdef' },
          },
        ]),
      )
      .mockResolvedValueOnce(Response.json({ id: 'container-application-1', name: 'cloudchef-workspace-user' }))
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 'rollout-1',
            created_at: '2026-08-05T00:00:00Z',
            status: 'progressing',
            target_configuration: targetConfiguration,
          },
        ]),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 'rollout-1',
          created_at: '2026-08-05T00:00:00Z',
          status: 'progressing',
          target_configuration: targetConfiguration,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 'rollout-1',
          created_at: '2026-08-05T00:00:00Z',
          status: 'completed',
          target_configuration: targetConfiguration,
        }),
      );
    const wait = vi.fn(async () => undefined);
    vi.stubGlobal('scheduler', { wait });

    await accountApi('user-account', 'user-token', request).ensureWorkspaceRuntimeContainer({
      applicationName: 'cloudchef-workspace-user',
      namespaceId: '0123456789abcdef0123456789abcdef',
      image,
    });

    expect(wait).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
    expect(request).toHaveBeenCalledTimes(5);
  });

  test('preserves Cloudflare Containers error details', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(
        Response.json(
          { success: false, errors: [{ code: 1000, message: 'wrangler_ssh must be an object' }] },
          { status: 400 },
        ),
      );

    await expect(
      accountApi('user-account', 'user-token', request).ensureWorkspaceRuntimeContainer({
        applicationName: 'cloudchef-workspace-user',
        namespaceId: '0123456789abcdef0123456789abcdef',
        image: `docker.io/cloudflare/sandbox:0.12.4@sha256:${'b'.repeat(64)}`,
      }),
    ).rejects.toThrow('wrangler_ssh must be an object');
  });

  test('rejects a matching container application without provider identity', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([{ name: 'cloudchef-workspace-user' }]));
    const api = accountApi('user-account', 'user-token', request);

    await expect(
      api.ensureWorkspaceRuntimeContainer({
        applicationName: 'cloudchef-workspace-user',
        namespaceId: '0123456789abcdef0123456789abcdef',
        image: `docker.io/cloudflare/sandbox:0.12.4@sha256:${'b'.repeat(64)}`,
      }),
    ).rejects.toThrow('invalid workspace container application');
    expect(request).toHaveBeenCalledOnce();
  });
  test('resolves a named KV namespace through the same paged account listing', async () => {
    const namespaceId = '0123456789abcdef0123456789abcdef';
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [{ id: 'f'.repeat(32), title: 'cloudchef-other-cache' }],
          result_info: { page: 1, total_pages: 2 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [{ id: namespaceId, title: 'cloudchef-deployment-1-cache' }],
          result_info: { page: 2, total_pages: 2 },
        }),
      );

    // A namespace on the second page must be reused, not created a second time.
    await expect(
      accountApi('account-1', 'token', request).ensureKvNamespace('cloudchef-deployment-1-cache'),
    ).resolves.toEqual({
      id: namespaceId,
      name: 'cloudchef-deployment-1-cache',
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
  });

  test('refuses to act on an ambiguous KV namespace name', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        success: true,
        result: [
          { id: '0'.repeat(32), title: 'cloudchef-deployment-1-cache' },
          { id: '1'.repeat(32), title: 'cloudchef-deployment-1-cache' },
        ],
      }),
    );

    await expect(
      accountApi('account-1', 'token', request).deleteKvNamespace('cloudchef-deployment-1-cache'),
    ).rejects.toThrow('ambiguous KV namespaces');
  });
});

describe('D1 migrations onto a database every revision deploys onto', () => {
  const DATABASE_ID = '0123456789abcdef0123456789abcdef';
  const notes = { name: '0001_notes.sql', sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)' };
  const titles = { name: '0002_titles.sql', sql: "ALTER TABLE notes ADD COLUMN title TEXT NOT NULL DEFAULT ''" };

  test('applies only what the database has not applied yet, keeping its data', async () => {
    const { database, request } = sqliteD1(DATABASE_ID);
    const api = accountApi('account-1', 'token', request);

    await api.applyD1Migrations(DATABASE_ID, [notes]);
    database.exec("INSERT INTO notes (body) VALUES ('written in production')");
    // The next revision adds a migration; replaying a set already applied changes nothing. Running
    // either again would fail: the table and the column exist.
    await api.applyD1Migrations(DATABASE_ID, [notes, titles]);
    await api.applyD1Migrations(DATABASE_ID, [notes, titles]);

    expect(
      database
        .prepare('SELECT id, body, title FROM notes')
        .all()
        .map((row) => ({ ...row })),
    ).toEqual([{ id: 1, body: 'written in production', title: '' }]);
    expect(
      database
        .prepare('SELECT name FROM cloudchef_runtime_migrations ORDER BY name')
        .all()
        .map((row) => row.name),
    ).toEqual(['0001_notes.sql', '0002_titles.sql']);
  });

  test('refuses an applied migration that changed before it applies any of the set', async () => {
    const { database, request } = sqliteD1(DATABASE_ID);
    const api = accountApi('account-1', 'token', request);
    const tags = { name: '0003_tags.sql', sql: 'CREATE TABLE tags (name TEXT PRIMARY KEY)' };
    await api.applyD1Migrations(DATABASE_ID, [notes, tags]);

    const changed = { ...tags, sql: 'CREATE TABLE tags (name TEXT PRIMARY KEY, color TEXT)' };
    const refusal = api.applyD1Migrations(DATABASE_ID, [notes, titles, changed]);

    await expect(refusal).rejects.toBeInstanceOf(D1MigrationChangedError);
    await expect(refusal).rejects.toMatchObject({ migrationName: '0003_tags.sql', appliedSql: tags.sql });
    // The migration ahead of the changed one did not run either.
    expect(
      database
        .prepare('PRAGMA table_info(notes)')
        .all()
        .map((column) => column.name),
    ).toEqual(['id', 'body']);
  });
});

describe('D1 migration receipts recorded before they kept the applied SQL', () => {
  const DATABASE_ID = '0123456789abcdef0123456789abcdef';

  test('gain the column, keep refusing an applied migration that changed, and quote what they can', async () => {
    const { database, request } = sqliteD1(DATABASE_ID);
    const placeholder = { name: '0001_app_data.sql', sql: '-- Add application D1 schema changes here.\nSELECT 1;' };
    database.exec(
      'CREATE TABLE cloudchef_runtime_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL, digest TEXT)',
    );
    database
      .prepare('INSERT INTO cloudchef_runtime_migrations (name, applied_at, digest) VALUES (?, ?, ?)')
      .run(placeholder.name, 1, await textDigest(placeholder.sql));
    const api = accountApi('account-1', 'token', request);
    const notes = { name: '0002_notes.sql', sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY)' };

    await api.applyD1Migrations(DATABASE_ID, [placeholder, notes]);

    expect(
      database
        .prepare('SELECT name, sql FROM cloudchef_runtime_migrations ORDER BY name')
        .all()
        .map((row) => ({ ...row })),
    ).toEqual([
      { name: '0001_app_data.sql', sql: null },
      { name: '0002_notes.sql', sql: notes.sql },
    ]);
    // The old receipt has no SQL to quote; the new one does.
    await expect(
      api.applyD1Migrations(DATABASE_ID, [{ ...placeholder, sql: 'CREATE TABLE app_data (id TEXT);' }, notes]),
    ).rejects.toMatchObject({ migrationName: '0001_app_data.sql', appliedSql: null });
    await expect(
      api.applyD1Migrations(DATABASE_ID, [placeholder, { ...notes, sql: 'CREATE TABLE notes (id TEXT)' }]),
    ).rejects.toMatchObject({ migrationName: '0002_notes.sql', appliedSql: notes.sql });
  });
});

/**
 * The D1 query API over one in-memory SQLite database: a statement, or a batch that commits or rolls
 * back whole, as D1 runs it.
 */
function sqliteD1(databaseId: string) {
  const database = new DatabaseSync(':memory:');
  const run = (statement: { sql: string; params?: SQLInputValue[] }) => ({
    success: true,
    results: database.prepare(statement.sql).all(...(statement.params ?? [])),
  });
  const request = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toContain(`/d1/database/${databaseId}/query`);
    // SAFETY: the account API sends D1 exactly one of these two query shapes.
    const body = JSON.parse(String(init?.body)) as
      { sql: string; params: SQLInputValue[] } | { batch: { sql: string; params: SQLInputValue[] }[] };
    try {
      if ('batch' in body) {
        database.exec('BEGIN');
        try {
          const result = body.batch.map(run);
          database.exec('COMMIT');
          return Response.json({ success: true, result });
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      }
      return Response.json({ success: true, result: [run(body)] });
    } catch (error) {
      return Response.json(
        { success: false, errors: [{ code: 7500, message: error instanceof Error ? error.message : 'D1 failed' }] },
        { status: 400 },
      );
    }
  });
  return { database, request };
}
