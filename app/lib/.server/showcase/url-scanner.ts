import { z } from 'zod';

/**
 * Cloudflare's URL Scanner in CloudChef's own account, checking each posted site for phishing and malware
 * (docs/proposals/showcase-and-feed.md, Moderation). A scan takes a while, so it is submitted now and its verdict read
 * later from the showcase queue. Without `URL_SCANNER_ACCOUNT_ID` and `URL_SCANNER_API_TOKEN` nothing is scanned:
 * reports alone hold a post.
 */

const API = 'https://api.cloudflare.com/client/v4/accounts';
const submittedSchema = z.looseObject({ uuid: z.string() });
const verdictSchema = z.looseObject({
  verdicts: z.looseObject({ overall: z.looseObject({ malicious: z.boolean() }) }),
});

function scannerOf(env: Env): { accountId: string; token: string } | null {
  const accountId = env.URL_SCANNER_ACCOUNT_ID?.trim();
  const token = env.URL_SCANNER_API_TOKEN?.trim();
  return accountId && token ? { accountId, token } : null;
}

/** Submits `url` for an unlisted scan; the scan's id, or null when scanning is off or the scanner refused. */
export async function submitScan(env: Env, url: string): Promise<string | null> {
  const scanner = scannerOf(env);
  if (!scanner) {
    return null;
  }
  const response = await fetch(`${API}/${encodeURIComponent(scanner.accountId)}/urlscanner/v2/scan`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${scanner.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, visibility: 'Unlisted' }),
  });
  if (!response.ok) {
    console.warn({ event: 'showcase_scan_refused', status: response.status });
    return null;
  }
  return submittedSchema.safeParse(await response.json().catch(() => null)).data?.uuid ?? null;
}

/** A scan's verdict: malicious or not, or still running (null). */
export async function scanVerdict(env: Env, scanId: string): Promise<{ malicious: boolean } | null> {
  const scanner = scannerOf(env);
  if (!scanner) {
    return { malicious: false };
  }
  const response = await fetch(
    `${API}/${encodeURIComponent(scanner.accountId)}/urlscanner/v2/result/${encodeURIComponent(scanId)}`,
    { headers: { Authorization: `Bearer ${scanner.token}` } },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`The URL Scanner answered ${response.status}.`);
  }
  const verdict = verdictSchema.safeParse(await response.json().catch(() => null)).data;
  return { malicious: verdict?.verdicts.overall.malicious === true };
}
