/**
 * Lowercase hex encoding of a byte buffer, optionally truncated to the first
 * `byteLength` bytes. Truncating here rather than slicing the hex string keeps
 * callers from having to reason about the 2-chars-per-byte factor.
 */
export function bytesToHex(input: ArrayBuffer | Uint8Array<ArrayBuffer>, byteLength?: number): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = byteLength === undefined ? bytes : bytes.subarray(0, byteLength);
  return Array.from(view, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of a UTF-8 string or byte buffer, as lowercase hex. */
export async function sha256Hex(
  value: string | ArrayBuffer | Uint8Array<ArrayBuffer>,
  byteLength?: number,
): Promise<string> {
  const input = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return bytesToHex(await crypto.subtle.digest('SHA-256', input), byteLength);
}

/**
 * Base64 of a byte buffer. Chunked because spreading a whole deployment asset into
 * `String.fromCharCode` exceeds the argument limit.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  }
  return btoa(binary);
}

/** URL-safe, unpadded base64: what OAuth parameters and bearer tokens carry. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
