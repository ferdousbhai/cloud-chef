/**
 * Why Google or an emailed link didn't sign someone in: they sign in to an existing CloudChef account, or
 * make one only for an address a team has invited. A new account otherwise starts with Cloudflare.
 */
export const NO_ACCOUNT_MESSAGE =
  "There's no CloudChef account for this address. Connect Cloudflare to start, or ask your team's admin to invite you.";

/** The sign-in page's search parameter naming why a sign-in was refused, and its one value. */
export const SIGN_IN_REFUSAL_PARAM = 'sign_in';
export const NO_ACCOUNT_REFUSAL = 'no_account';
