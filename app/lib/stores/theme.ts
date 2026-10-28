import { atom } from 'nanostores';

export type Theme = 'dark' | 'light';
/** What the person chose in Settings: a theme, or to follow the device's (the default). */
export type ThemePreference = Theme | 'system';

/** Holds a chosen theme; absent while the page follows the device, as `__root.tsx`'s early script reads it. */
export const THEME_KEY = 'cloudchef_theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export const themePreferenceStore = atom<ThemePreference>(storedPreference());
/** The theme the page shows now. */
export const themeStore = atom<Theme>(resolve(themePreferenceStore.get()));

function isTheme(value: string | null): value is Theme {
  return value === 'dark' || value === 'light';
}

function storedPreference(): ThemePreference {
  try {
    // Absent on the server, where reading it throws and the page follows the device.
    const stored = localStorage.getItem(THEME_KEY);
    return isTheme(stored) ? stored : 'system';
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
    return 'system';
  }
}

function deviceTheme(): Theme {
  return globalThis.window?.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
}

function resolve(preference: ThemePreference): Theme {
  return preference === 'system' ? deviceTheme() : preference;
}

/** Saves the person's choice and shows it at once. */
export function setThemePreference(preference: ThemePreference) {
  themePreferenceStore.set(preference);
  themeStore.set(resolve(preference));
  try {
    if (preference === 'system') {
      localStorage.removeItem(THEME_KEY);
    } else {
      localStorage.setItem(THEME_KEY, preference);
    }
  } catch {
    // The choice still holds for this page.
  }
}

// Following the device: when it switches between light and dark, so does the page.
// Not on the server, where there is no window.
globalThis.window?.matchMedia?.(DARK_QUERY).addEventListener('change', () => {
  if (themePreferenceStore.get() === 'system') {
    themeStore.set(deviceTheme());
  }
});
