import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { buttonClassNames, type ButtonVisualProps } from './Button';

type MenuProps = {
  children: ReactNode;
  buttonProps?: Pick<ButtonVisualProps, 'children' | 'className' | 'icon' | 'inline' | 'size' | 'tip' | 'variant'> & {
    'aria-label'?: string;
    title?: string;
  };
};

export function Menu({ children, buttonProps }: MenuProps) {
  const triggerLabel = buttonProps?.['aria-label'];
  const triggerTitle = buttonProps?.tip ?? buttonProps?.title;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={triggerLabel ?? triggerTitle}
          title={triggerTitle}
          className={buttonClassNames({
            className: buttonProps?.className,
            variant: buttonProps?.variant,
            size: buttonProps?.size,
            inline: buttonProps?.inline,
          })}
        >
          {buttonProps?.icon}
          {buttonProps?.children}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-label={triggerLabel ?? triggerTitle}
          className="z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-52 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-1.5 text-content-primary shadow-panel outline-none backdrop-blur-xl"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({ children, action }: { children: ReactNode; action?: () => void }) {
  return (
    <DropdownMenu.Item
      className="flex min-h-10 w-full items-center gap-2.5 rounded-lg border-0 bg-transparent px-3 py-2 text-left text-sm font-medium text-content-primary outline-none transition-colors hover:bg-bolt-elements-background-depth-2 focus-visible:bg-bolt-elements-background-depth-2"
      onSelect={action}
    >
      {children}
    </DropdownMenu.Item>
  );
}
