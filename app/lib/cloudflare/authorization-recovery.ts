export const CLOUDFLARE_AUTHORIZATION_ERROR_PARAM = 'cloudflare_authorization';
export const CLOUDFLARE_AUTHORIZATION_ERROR_VALUE = 'failed';

export const CLOUDFLARE_AUTHORIZATION_ERROR_MESSAGE = "Cloudflare couldn't authorize this connection. Try again.";

/**
 * Settings' search parameter saying why a return from Cloudflare did not finish connecting. It carries
 * only a code, and Settings shows its fixed text: a link can't put words of its own on CloudChef's page.
 */
export const CLOUDFLARE_CONNECT_MESSAGE_PARAM = 'cloudflare_message';

const CLOUDFLARE_CONNECT_MESSAGES = {
  other_browser:
    'That Cloudflare authorization was started in another browser or tab. Connect Cloudflare again from here.',
  already_finished:
    'That Cloudflare authorization was already finished, or is no longer known. Connect Cloudflare again if you need to.',
  expired: 'That Cloudflare authorization expired. Connect Cloudflare again.',
  admin_only: "Only a team's admin can connect its Cloudflare account.",
  account_in_use:
    'Someone else already builds in this Cloudflare account with CloudChef, on their own or in a team you ' +
    "don't run, and connecting it here would replace the access they use. If it's a team, ask whoever runs " +
    'it to make you one of its admins, then connect again. Otherwise, connect a different Cloudflare account.',
  changed_meanwhile:
    'Cloudflare was connected from somewhere else at the same moment, so CloudChef left everything as it was. ' +
    'Connect Cloudflare again.',
  login_linked_elsewhere:
    'This Cloudflare login already belongs to another CloudChef account, or yours is linked to a different ' +
    'Cloudflare login. Sign in with Cloudflare to use it.',
  email_has_account:
    'This email already has a CloudChef account. Sign in with Google or an emailed link, then connect Cloudflare in Settings.',
  authorization_incomplete:
    "Cloudflare's authorization didn't give CloudChef what it needs. Connect Cloudflare again, choose one " +
    'account, and approve every requested permission.',
  session_ended:
    'Cloudflare is connected, but your CloudChef session ended before it finished. Sign in again to build in it.',
  unreadable: 'That Cloudflare authorization couldn’t be read. Connect Cloudflare again.',
  unavailable: 'Cloudflare couldn’t be connected just now. Try again.',
} as const;

export type CloudflareConnectMessage = keyof typeof CLOUDFLARE_CONNECT_MESSAGES;

const connectMessages = new Map<string, string>(Object.entries(CLOUDFLARE_CONNECT_MESSAGES));

/** The text for a code from Settings' URL, or null for anything that isn't one. */
export function cloudflareConnectMessageText(code: string): string | null {
  return connectMessages.get(code) ?? null;
}
