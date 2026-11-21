/**
 * The two search parameters of a sign-in that met an account made with Cloudflare
 * (`CloudflareAccountHoldsEmailError`). The first is on the page Google returns to, and has the sign-in
 * page say that the address already has an account and offer Cloudflare. The second is on the page
 * Cloudflare then returns to: signed in, the person goes through Google once more, which proves the
 * address on that account, so Google opens it from then on.
 */
export const ACCOUNT_MADE_WITH_PARAM = 'account_made_with';
export const ACCOUNT_MADE_WITH_CLOUDFLARE = 'cloudflare';
export const PROVE_ADDRESS_WITH_PARAM = 'prove_address_with';
export const PROVE_ADDRESS_WITH_GOOGLE = 'google';
/** The `code` of the answer to an emailed link whose address an account made with Cloudflare already carries. */
export const ACCOUNT_MADE_WITH_CLOUDFLARE_CODE = 'account_made_with_cloudflare';

/** `href` without either parameter, and with `prove` set, asking for the trip through Google once signed in. */
export function accountNoticeReturnURL(href: string, prove: boolean): string {
  const url = new URL(href);
  url.searchParams.delete(ACCOUNT_MADE_WITH_PARAM);
  url.searchParams.delete(PROVE_ADDRESS_WITH_PARAM);
  if (prove) {
    url.searchParams.set(PROVE_ADDRESS_WITH_PARAM, PROVE_ADDRESS_WITH_GOOGLE);
  }
  return url.toString();
}

/** Whether this page's address carries `param` set to `value`; false where there is no page, as on the server. */
export function pageHasParam(param: string, value: string): boolean {
  try {
    return new URL(window.location.href).searchParams.get(param) === value;
  } catch {
    return false;
  }
}
