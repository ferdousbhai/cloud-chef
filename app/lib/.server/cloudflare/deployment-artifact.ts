import { blake3 } from '@noble/hashes/blake3.js';
import { extname } from 'node:path';
import { bytesToBase64, bytesToHex } from '~/lib/hex-digest';

export type DeploymentArtifactFile = {
  path: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
};

/** Both project types build through cf, and the bundled Worker is always collapsed to this one module. */
export const WORKER_MAIN_MODULE = 'index.js' as const;

export async function deploymentAssetHash(file: Pick<DeploymentArtifactFile, 'path' | 'bytes'>): Promise<string> {
  // Wrangler 4.118.0's Workers Assets protocol hashes the base64 payload plus
  // its extension with BLAKE3 and sends the first 128 bits as lowercase hex.
  const input = new TextEncoder().encode(`${bytesToBase64(file.bytes)}${deploymentAssetExtension(file.path)}`);
  return bytesToHex(blake3(input)).slice(0, 32);
}

export function deploymentAssetExtension(path: string): string {
  return extname(path).slice(1);
}
