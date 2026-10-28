const REAUTHENTICATING_USER_KEY = 'cloudchef_reauthenticating_user';

/**
 * Who started a fresh sign-in to export or erase their account. Signing in again can land in another
 * account (another Google account, another address), and export or erasure must then not act on it
 * without the person noticing.
 */
export function recordReauthenticatingUser(userId: string): void {
  try {
    window.sessionStorage.setItem(REAUTHENTICATING_USER_KEY, userId);
  } catch {
    // Best-effort: without browser storage the warning just can't be shown.
  }
}

/** Reads the record without spending it: true when the fresh sign-in landed in a different account. */
export function reauthenticationSwitchedAccount(currentUserId: string): boolean {
  try {
    const started = window.sessionStorage.getItem(REAUTHENTICATING_USER_KEY);
    return started !== null && started !== currentUserId;
  } catch {
    return false;
  }
}

/** Spends the record, once what it says has been read. */
export function forgetReauthenticatingUser(): void {
  try {
    window.sessionStorage.removeItem(REAUTHENTICATING_USER_KEY);
  } catch {
    // Nothing stored to forget.
  }
}
