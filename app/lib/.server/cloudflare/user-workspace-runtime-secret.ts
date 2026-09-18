import { bytesToBase64Url } from '~/lib/hex-digest';

const RUNTIME_SECRET_BYTES = 32;
const RUNTIME_SECRET_SALT = new TextEncoder().encode('cloudchef-user-workspace-runtime-control-v1');

export async function deriveUserWorkspaceRuntimeSecret(args: {
  encryptionKeyBase64: string;
  userId: string;
  accountId: string;
  connectionGeneration: number;
}): Promise<string> {
  if (!args.userId || !args.accountId || !Number.isSafeInteger(args.connectionGeneration)) {
    throw new Error('The user-owned workspace runtime identity is invalid.');
  }
  const keyBytes = decodeBase64(args.encryptionKeyBase64);
  if (keyBytes.byteLength !== 32) {
    throw new Error('Cloudflare credential encryption key must decode to 32 bytes.');
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, 'HKDF', false, ['deriveBits']);
  const info = new TextEncoder().encode(
    JSON.stringify({
      purpose: 'user-workspace-runtime-control',
      userId: args.userId,
      accountId: args.accountId,
      connectionGeneration: args.connectionGeneration,
    }),
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: RUNTIME_SECRET_SALT, info },
    key,
    RUNTIME_SECRET_BYTES * 8,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new Error('Cloudflare credential encryption key is not valid base64.');
  }
}
