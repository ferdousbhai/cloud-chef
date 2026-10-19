import { z } from 'zod';
import {
  createAuthSession,
  getAuthSession,
  normalizeEmail,
  prepareAuthSession,
  upsertVerifiedEmailUser,
} from '~/lib/.server/auth';
import { IdentityConflictError } from '~/lib/.server/identity-conflict-error';
import { hasSameOrigin, readJsonRequest, safeReturnTo } from '~/lib/.server/request-guards';
import { bytesToBase64Url, sha256Hex } from '~/lib/hex-digest';

/**
 * Signing in with a one-time link sent by email: how people without a Cloudflare login (members of an
 * organization) reach CloudChef. Only the link's SHA-256 is stored. The emailed link opens a page
 * whose button completes the sign-in, so a mail scanner that fetches the link can't use it up.
 */
const EMAIL_SIGN_IN_LINK_TTL_MS = 15 * 60_000;
/** Links sent to one address per hour, so the form can't be used to flood someone's inbox. */
export const EMAIL_SIGN_IN_LINKS_PER_HOUR = 5;
const EMAIL_SIGN_IN_PATH = '/sign-in/email';
const SENDER = { email: 'noreply@cloudchef.build', name: 'CloudChef' };

const startSchema = z.strictObject({
  email: z.email().max(254),
  callbackURL: z.string().max(2_048).optional(),
});
const completeSchema = z.strictObject({ token: z.string().min(32).max(128) });

export async function startEmailSignInAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!hasSameOrigin(request)) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  const { success } = await env.SIGN_IN_RATE_LIMITER.limit({
    key: request.headers.get('CF-Connecting-IP') ?? 'unknown',
  });
  if (!success) {
    return Response.json({ error: 'Too many sign-in attempts. Try again shortly.' }, { status: 429 });
  }
  const body = await readJsonRequest(request, startSchema, 'Enter a valid email address.');
  if ('response' in body) {
    return body.response;
  }
  const payload = body.data;
  if (!env.SIGN_IN_EMAIL) {
    return Response.json({ error: 'Email sign-in is not configured for this environment.' }, { status: 503 });
  }
  const email = normalizeEmail(payload.email);
  const now = Date.now();
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS sent FROM email_sign_in_tokens WHERE email = ? AND created_at > ?',
  )
    .bind(email, now - 60 * 60_000)
    .first<{ sent: number }>();
  // The same answer either way: whether a link went out says nothing about the address.
  const accepted = Response.json({ sent: true }, { status: 202 });
  if ((recent?.sent ?? 0) >= EMAIL_SIGN_IN_LINKS_PER_HOUR) {
    return accepted;
  }
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const origin = new URL(request.url).origin;
  await env.DB.prepare(
    `INSERT INTO email_sign_in_tokens (token_hash, email, return_to, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256Hex(token),
      email,
      safeReturnTo(payload.callbackURL, origin),
      now + EMAIL_SIGN_IN_LINK_TTL_MS,
      now,
    )
    .run();
  const link = new URL(EMAIL_SIGN_IN_PATH, origin);
  link.searchParams.set('token', token);
  try {
    await env.SIGN_IN_EMAIL.send({
      from: SENDER,
      to: email,
      subject: 'Sign in to CloudChef',
      text: signInText(link.toString()),
      html: signInHtml(link.toString()),
    });
  } catch {
    console.error('Unable to send a CloudChef sign-in email');
    return Response.json({ error: 'The sign-in email could not be sent. Try again shortly.' }, { status: 502 });
  }
  return accepted;
}

/**
 * Which address a sign-in link is for, without using it up. The confirmation page shows it, so a link
 * someone else requested for their own address can't quietly sign you into their account.
 */
export async function describeEmailSignInAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!hasSameOrigin(request)) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  const body = await readJsonRequest(request, completeSchema, 'This sign-in link is not valid.');
  if ('response' in body) {
    return body.response;
  }
  const link = await env.DB.prepare(
    'SELECT email FROM email_sign_in_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
  )
    .bind(await sha256Hex(body.data.token), Date.now())
    .first<{ email: string }>();
  if (!link) {
    return Response.json(
      { error: 'This sign-in link has been used or has expired. Ask for a new one.' },
      { status: 410 },
    );
  }
  return Response.json({ email: link.email }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function completeEmailSignInAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!hasSameOrigin(request)) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  const body = await readJsonRequest(request, completeSchema, 'This sign-in link is not valid.');
  if ('response' in body) {
    return body.response;
  }
  const { token } = body.data;
  const now = Date.now();
  // Used once: the update is the claim, so two tabs opening one link can't both sign in.
  const claimed = await env.DB.prepare(
    `UPDATE email_sign_in_tokens SET used_at = ?
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
     RETURNING email, return_to`,
  )
    .bind(now, await sha256Hex(token), now)
    .first<{ email: string; return_to: string }>();
  if (!claimed) {
    return Response.json(
      { error: 'This sign-in link has been used or has expired. Ask for a new one.' },
      { status: 410 },
    );
  }
  try {
    const signedIn = await getAuthSession(env, request);
    const user = await upsertVerifiedEmailUser(env.DB, { email: claimed.email }, Date.now(), signedIn?.user.id ?? null);
    const session = await prepareAuthSession(user.id, request);
    const cookie = await createAuthSession(env, session);
    return Response.json(
      { returnTo: safeReturnTo(claimed.return_to, new URL(request.url).origin) },
      { headers: { 'Set-Cookie': cookie, 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof IdentityConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    console.error('Unable to complete an email sign-in');
    return Response.json({ error: 'Signing in failed. Try again.' }, { status: 500 });
  }
}

function signInText(link: string): string {
  return [
    'Sign in to CloudChef with this link:',
    '',
    link,
    '',
    `It works once, for the next ${EMAIL_SIGN_IN_LINK_TTL_MS / 60_000} minutes.`,
    "If you didn't ask to sign in, ignore this email.",
  ].join('\n');
}

function signInHtml(link: string): string {
  const href = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<p>Sign in to CloudChef:</p>
<p><a href="${href}">Sign in</a></p>
<p>The link works once, for the next ${EMAIL_SIGN_IN_LINK_TTL_MS / 60_000} minutes. If you didn't ask to sign in, ignore this email.</p>`;
}
