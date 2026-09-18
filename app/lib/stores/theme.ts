import { atom } from 'nanostores';

export type Theme = 'dark' | 'light';

const THEME_KEY = 'cloudchef_theme';

const DEFAULT_THEME = 'light';

export const themeStore = atom<Theme>(initStore());

function isTheme(value: string | null): value is Theme {
  return value === 'dark' || value === 'light';
}

function initStore() {
  if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof localStorage !== 'undefined') {
    const persistedTheme = localStorage.getItem(THEME_KEY);
    const themeAttribute = document.documentElement.getAttribute('class');

    if (isTheme(persistedTheme)) {
      return persistedTheme;
    }

    if (isTheme(themeAttribute)) {
      return themeAttribute;
    }
  }

  return DEFAULT_THEME;
}

export function toggleTheme() {
  if (typeof document === 'undefined' || typeof localStorage === 'undefined') {
    return;
  }

  const currentTheme = themeStore.get();
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

  themeStore.set(newTheme);
  localStorage.setItem(THEME_KEY, newTheme);
}
