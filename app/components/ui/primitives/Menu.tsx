import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { buttonClassNames, type ButtonVisualProps } from './Button';

type MenuProps = {
  children: ReactNode;
  /** The trigger's look; its title also names it and the menu it opens. */
  buttonProps: Pick<ButtonVisualProps, 'children' | 'className' | 'icon' | 'inline' | 'size' | 'variant'> & {
    title: string;
  };
  /** Which edge of the trigger the menu lines up with: its end by default, its start for one at the left. */
  align?: 'start' | 'end';
};

export function Menu({ children, buttonProps, align = 'end' }: MenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={buttonProps.title}
          title={buttonProps.title}
          className={buttonClassNames({
            className: buttonProps.className,
            variant: buttonProps.variant,
            size: buttonProps.size,
            inline: buttonProps.inline,
          })}
        >
          {buttonProps.icon}
          {buttonProps.children}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={8}
          collisionPadding={8}
          aria-label={buttonProps.title}
          className="z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-52 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-1.5 text-content-primary shadow-panel outline-hidden backdrop-blur-xl"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  children,
  action,
  danger = false,
}: {
  children: ReactNode;
  action?: () => void;
  /** A destructive item, in the error color. */
  danger?: boolean;
}) {
  return (
    <DropdownMenu.Item
      className={`flex min-h-10 w-full items-center gap-2.5 rounded-lg border-0 bg-transparent px-3 py-2 text-left text-sm font-medium outline-hidden transition-colors hover:bg-bolt-elements-background-depth-2 focus-visible:bg-bolt-elements-background-depth-2 ${danger ? 'text-content-error' : 'text-content-primary'}`}
      onSelect={action}
    >
      {children}
    </DropdownMenu.Item>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-bolt-elements-borderColor" />;
}
