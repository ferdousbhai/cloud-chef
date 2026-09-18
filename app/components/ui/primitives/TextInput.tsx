import type { InputHTMLAttributes, Ref } from 'react';
import { classNames } from '~/utils/classNames';

export function TextInput({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={classNames(
        'min-h-9 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-1.5 text-sm text-content-primary outline-none transition-shadow focus:border-accent-500 focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--cc-content-accent)_24%,transparent)]',
        className,
      )}
      {...props}
    />
  );
}
