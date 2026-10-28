// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY, setThemePreference, themeStore } from '~/lib/stores/theme';
import { AppearanceCard } from './AppearanceCard';

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  setThemePreference('system');
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function choice(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (button) => button.textContent === label,
  );
  if (!found) {
    throw new Error(`No ${label} choice`);
  }
  return found;
}

describe('Appearance', () => {
  it('follows the device until a theme is chosen, keeps the choice, and goes back to following it', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => root?.render(<AppearanceCard />));

    expect(choice('System').getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem(THEME_KEY)).toBeNull();

    await act(async () => choice('Dark').click());
    expect(choice('Dark').getAttribute('aria-checked')).toBe('true');
    expect(themeStore.get()).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');

    await act(async () => choice('System').click());
    // Nothing stored means the page follows the device, as its early script reads it.
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });
});
