import { describe, expect, it } from 'vitest';
import { suggestedUsername, usernameProblem } from './usernames';

describe('usernames', () => {
  it('takes what GitHub would', () => {
    for (const name of ['ferdous', 'sara', 'a', 'ada-lovelace', 'x9', 'a'.repeat(39)]) {
      expect(usernameProblem(name), name).toBeNull();
    }
  });

  it('refuses what an address can’t carry, and names CloudChef’s own pages use', () => {
    for (const name of ['', 'Ada', '-ada', 'ada-', 'ada--lovelace', 'ada_l', 'ada.l', 'a'.repeat(40)]) {
      expect(usernameProblem(name), name).toMatch(/lowercase letters/);
    }
    for (const name of ['git', 'api', 'settings', 'login', 'chat']) {
      expect(usernameProblem(name), name).toMatch(/kept for CloudChef/);
    }
  });

  it('suggests one from an email or a name', () => {
    expect(suggestedUsername('saraadolfsen@gmail.com')).toBe('saraadolfsen');
    expect(suggestedUsername('Ada Lovelace')).toBe('ada-lovelace');
    expect(suggestedUsername('___')).toBe('');
  });
});
