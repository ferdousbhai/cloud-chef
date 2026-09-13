import { z } from 'zod';

const CAPABILITY_VERSION = 1;
const RUNTIME_CAPABILITY_TTL_MS = 5 * 60_000;

type RuntimeCapability = {
  version: typeof CAPABILITY_VERSION;
  subject: string;
  origin: string;
  expiresAt: number;
  nonce: string;
};

/** Extra members are preserved rather than stripped so an older minting format still round-trips. */
const runtimeCapabilitySchema = z.looseObject({
  version: z.literal(CAPABILITY_VERSION),
  subject: z.string().min(1).max(512),
  origin: z.string(),
  expiresAt: z.number().int(),
  nonce: z.string().regex(/^[0-9a-f-]{36}$/i),
});

export async function mintRuntimeCapability(args: {
  secret: string;
  subject: string;
  origin: string;
  now?: number;
}): Promise<{ token: string; expiresAt: number }> {
  requireSecret(args.secret);
  const expiresAt = (args.now ?? Date.now()) + RUNTIME_CAPABILITY_TTL_MS;
  const payload: RuntimeCapability = {
    version: CAPABILITY_VERSION,
    subject: requireBoundedString(args.subject, 'capability subject', 512),
    origin: requireOrigin(args.origin),
    expiresAt,
    nonce: crypto.randomUUID(),
  };
  const encoded = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await sign(args.secret, encoded);
  return { token: `${encoded}.${signature}`, expiresAt };
}

export async function verifyRuntimeCapability(
  secret: string,
  token: string,
  options: { origin?: string | null; now?: number } = {},
): Promise<RuntimeCapability | null> {
  try {
    requireSecret(secret);
    const [encoded, suppliedSignature, extra] = token.split('.');
    if (!encoded || !suppliedSignature || extra !== undefined) {
      return null;
    }
    const expectedSignature = await sign(secret, encoded);
    if (!constantTimeEqual(suppliedSignature, expectedSignature)) {
      return null;
    }
    const parsed = runtimeCapabilitySchema.safeParse(JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))));
    if (!parsed.success) {
      return null;
    }
    const capability = parsed.data;
    requireOrigin(capability.origin);
    if (
      capability.expiresAt <= (options.now ?? Date.now()) ||
      (options.origin !== undefined && options.origin !== null && capability.origin !== options.origin)
    ) {
      return null;
    }
    return capability;
  } catch {
    return null;
  }
}

function requireSecret(value: string): void {
  if (value.length < 32) {
    throw new Error('Runtime capability secret is not configured.');
  }
}

function requireBoundedString(value: string, name: string, maximumLength: number): string {
  if (!value || value.length > maximumLength) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function requireOrigin(value: string): string {
  const origin = new URL(value).origin;
  if (
    origin !== value ||
    (new URL(origin).protocol !== 'https:' && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin))
  ) {
    throw new Error('Invalid runtime capability origin.');
  }
  return origin;
}

async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid base64url value.');
  }
  const padded = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
