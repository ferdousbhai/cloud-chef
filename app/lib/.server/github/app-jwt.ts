import { bytesToBase64Url } from '~/lib/hex-digest';

/**
 * The JSON Web Token a GitHub App signs to act as itself (RS256), good for nine minutes: GitHub
 * accepts at most ten, and `iat` is backdated a minute for clock drift. `privateKeyPem` is the App's
 * key in PKCS#8 (`BEGIN PRIVATE KEY`); GitHub issues PKCS#1, converted once with
 * `openssl pkcs8 -topk8 -nocrypt`.
 */
export async function createGitHubAppJwt(clientId: string, privateKeyPem: string, now = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const issuedAt = Math.floor(now / 1_000) - 60;
  const header = encodeSegment(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = encodeSegment(JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: clientId }));
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function encodeSegment(json: string): string {
  return bytesToBase64Url(new TextEncoder().encode(json));
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  if (pem.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error('The GitHub App key must be PKCS#8: convert it with `openssl pkcs8 -topk8 -nocrypt`.');
  }
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    der[index] = binary.charCodeAt(index);
  }
  return der;
}
