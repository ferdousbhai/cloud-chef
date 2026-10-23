import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { classNames } from '~/utils/classNames';

type IconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'className' | 'disabled' | 'onClick' | 'title' | 'type'
> & {
  icon: ReactNode;
  className?: string;
  title: string;
  disabled?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
};

export function IconButton({
  icon,
  className,
  disabled = false,
  title,
  'aria-label': ariaLabel,
  onClick,
  ...buttonProps
}: IconButtonProps) {
  return (
    <button
      {...buttonProps}
      className={classNames(
        'cc-icon-button flex items-center text-content-primary bg-transparent enabled:hover:text-bolt-elements-item-contentActive rounded-md p-1 enabled:hover:bg-bolt-elements-item-backgroundActive disabled:cursor-not-allowed',
        { 'opacity-30': disabled },
        className,
      )}
      type="button"
      aria-label={ariaLabel ?? title}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
