import { memo, type MouseEvent, type ReactNode } from 'react';
import { classNames } from '~/utils/classNames';

interface PanelHeaderButtonProps {
  className?: string;
  disabled?: boolean;
  /** Hover and assistive-technology explanation for a button whose label alone is ambiguous. */
  title?: string;
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}

export const PanelHeaderButton = memo(function PanelHeaderButton({
  className,
  disabled = false,
  title,
  children,
  onClick,
}: PanelHeaderButtonProps) {
  return (
    <button
      type="button"
      className={classNames(
        'cc-icon-button flex items-center shrink-0 gap-1.5 px-1.5 rounded-md py-0.5 text-content-secondary bg-transparent enabled:hover:text-bolt-elements-item-contentActive enabled:hover:bg-bolt-elements-item-backgroundActive disabled:cursor-not-allowed',
        {
          'opacity-30': disabled,
        },
        className,
      )}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
});
