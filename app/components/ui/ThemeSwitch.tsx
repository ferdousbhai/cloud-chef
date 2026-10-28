import { useStore } from '@nanostores/react';
import { memo, useSyncExternalStore } from 'react';
import { themeStore, toggleTheme } from '~/lib/stores/theme';
import { SunIcon, MoonIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';

interface ThemeSwitchProps {
  className?: string;
}

export const ThemeSwitch = memo(function ThemeSwitch({ className }: ThemeSwitchProps) {
  const theme = useStore(themeStore);
  // Shown only in the browser, once hydrated: the server can't know the theme the page will use.
  const domLoaded = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

  return (
    domLoaded && (
      <Button
        variant="neutral"
        inline
        aria-label="Toggle Theme"
        className={className}
        onClick={toggleTheme}
        tip={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        icon={theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      />
    )
  );
});

function subscribeToNothing(): () => void {
  return () => undefined;
}
