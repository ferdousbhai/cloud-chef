export const CLOUDFLARE_AUTHORIZATION_ERROR_PARAM = 'cloudflare_authorization';
export const CLOUDFLARE_AUTHORIZATION_ERROR_VALUE = 'failed';

export const CLOUDFLARE_AUTHORIZATION_ERROR_MESSAGE = "Cloudflare couldn't authorize this connection. Try again.";

/**
 * Settings' search parameter saying why a return from Cloudflare did not finish connecting: one of
 * CloudChef's own messages, shown as plain text.
 */
export const CLOUDFLARE_CONNECT_MESSAGE_PARAM = 'cloudflare_message';

/** The longest such message Settings shows. */
export const CLOUDFLARE_CONNECT_MESSAGE_MAX_LENGTH = 300;
