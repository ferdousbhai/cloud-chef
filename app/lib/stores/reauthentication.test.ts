// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { recordReauthenticatingUser, takeReauthenticationSwitchedAccount } from './reauthentication';

describe('re-authentication account check', () => {
  it('notices a fresh sign-in that landed in another account, once', () => {
    recordReauthenticatingUser('user-1');
    expect(takeReauthenticationSwitchedAccount('user-2')).toBe(true);
    expect(takeReauthenticationSwitchedAccount('user-2')).toBe(false);
  });

  it('stays quiet when the same account signed in again, or nobody asked', () => {
    recordReauthenticatingUser('user-1');
    expect(takeReauthenticationSwitchedAccount('user-1')).toBe(false);
    expect(takeReauthenticationSwitchedAccount('user-1')).toBe(false);
  });
});
