import { describe, expect, it } from 'vitest';
import {
  deploymentAssetHash,
  validatePreparedDeploymentArtifact,
  type DeploymentArtifactFile,
} from './deployment-artifact';

async function file(path: string, contents: string): Promise<DeploymentArtifactFile> {
  const bytes = new TextEncoder().encode(contents);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return {
    path,
    bytes,
    size: bytes.byteLength,
    sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

describe('deployment artifact boundary', () => {
  it.each([
    ['assets/app.js', 'console.log("cloudchef")', '5ca2b008d319d8d6c1f5ad3a5d8c1cb6'],
    ['index.html', '<h1>CloudChef</h1>', '8cc74b7ba69fed67b2314fa923e48abf'],
    ['assets/empty.css', '', '9e7a27539226d700e116522ee435029d'],
    ['folder.with-dot/README', 'same', '326e42311d122dad1520039b805a8305'],
  ])('matches the Wrangler 4.118.0 Workers Assets hash for %s', async (path, contents, expected) => {
    await expect(deploymentAssetHash(await file(path, contents))).resolves.toBe(expected);
  });

  it('deduplicates identical content only when its extension is also identical', async () => {
    const first = await file('one/a.txt', 'same');
    const duplicate = await file('two/b.txt', 'same');
    const differentExtension = await file('two/b.css', 'same');

    await expect(deploymentAssetHash(first)).resolves.toBe('294c70315fabb0e34fe77cab66676f1b');
    await expect(deploymentAssetHash(duplicate)).resolves.toBe('294c70315fabb0e34fe77cab66676f1b');
    await expect(deploymentAssetHash(differentExtension)).resolves.toBe('91d7ba6fd041bc194050195f6fe406e0');
  });

  it('rejects path traversal, byte tampering, and Worker-only static assets', async () => {
    const main = await file('server.js', 'export default {}');
    const asset = await file('index.html', '<h1>CloudChef</h1>');
    await expect(
      validatePreparedDeploymentArtifact(
        {
          revision: 'a'.repeat(64),
          mainModule: 'server.js',
          modules: [main],
          assets: [asset],
          migrations: { DB: [], AGENT_SECURITY_DB: [] },
        },
        { revision: 'a'.repeat(64), projectType: 'worker' },
      ),
    ).rejects.toThrow('cannot contain static assets');

    await expect(
      validatePreparedDeploymentArtifact(
        {
          revision: 'a'.repeat(64),
          mainModule: 'index.js',
          modules: [{ ...(await file('index.js', 'export default {}')), path: '../index.js' }],
          assets: [],
          migrations: { DB: [], AGENT_SECURITY_DB: [] },
        },
        { revision: 'a'.repeat(64), projectType: 'web_app' },
      ),
    ).rejects.toThrow('invalid');

    await expect(
      validatePreparedDeploymentArtifact(
        {
          revision: 'a'.repeat(64),
          mainModule: 'index.js',
          modules: [await file('index.js', 'export default {}')],
          assets: [await file('INDEX.JS', 'asset')],
          migrations: { DB: [], AGENT_SECURITY_DB: [] },
        },
        { revision: 'a'.repeat(64), projectType: 'web_app' },
      ),
    ).rejects.toThrow('invalid');

    const tampered = await file('index.js', 'export default {}');
    tampered.bytes[0] = 0;
    await expect(
      validatePreparedDeploymentArtifact(
        {
          revision: 'a'.repeat(64),
          mainModule: 'index.js',
          modules: [tampered],
          assets: [],
          migrations: { DB: [], AGENT_SECURITY_DB: [] },
        },
        { revision: 'a'.repeat(64), projectType: 'web_app' },
      ),
    ).rejects.toThrow('invalid');
  });
});
