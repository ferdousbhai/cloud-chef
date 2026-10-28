import { useStore } from '@nanostores/react';
import { setThemePreference, themePreferenceStore, type ThemePreference } from '~/lib/stores/theme';
import { classNames } from '~/utils/classNames';
import { SettingsCard } from './SettingsLayout';

const CHOICES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Light or dark, or following the device's setting (the default). Kept in this browser. */
export function AppearanceCard() {
  const preference = useStore(themePreferenceStore);
  return (
    <SettingsCard id="appearance" title="Appearance" description="System follows your device's light or dark setting.">
      <div
        role="radiogroup"
        aria-label="Theme"
        className="mt-3 inline-flex rounded-md border border-bolt-elements-borderColor p-0.5"
      >
        {CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={preference === choice.value}
            onClick={() => setThemePreference(choice.value)}
            className={classNames(
              'rounded px-3 py-1 text-sm',
              preference === choice.value
                ? 'bg-bolt-elements-background-depth-3 text-content-primary'
                : 'text-content-secondary hover:text-content-primary',
            )}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </SettingsCard>
  );
}
