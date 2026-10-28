import type { HTMLAttributes } from 'react';
import { classNames } from '~/utils/classNames';

export function Sheet({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={classNames(
        'rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 shadow-xs',
        className,
      )}
      {...props}
    />
  );
}
