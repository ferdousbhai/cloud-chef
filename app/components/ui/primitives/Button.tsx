import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { classNames } from '~/utils/classNames';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'neutral' | 'danger' | 'subtle';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export type ButtonVisualProps = {
  children?: ReactNode;
  className?: string;
  icon?: ReactNode;
  tip?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  inline?: boolean;
  loading?: boolean;
  disabled?: boolean;
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type'];
};

type NativeButtonProps = ButtonVisualProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonVisualProps>;

type ButtonProps = NativeButtonProps & { ref?: Ref<HTMLButtonElement> };

const variantClasses = {
  primary: 'bg-accent-500',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  neutral:
    'border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-content-primary hover:bg-bolt-elements-background-depth-3',
  subtle:
    'border border-transparent bg-transparent text-content-secondary hover:bg-bolt-elements-background-depth-2 hover:text-content-primary',
} satisfies Record<ButtonVariant, string>;

const sizeClasses = {
  xs: 'min-h-7 px-2 py-1 text-xs',
  sm: 'min-h-8 px-2.5 py-1.5 text-sm',
  md: 'min-h-9 px-3 py-2 text-sm',
  lg: 'min-h-10 px-4 py-2 text-base',
} satisfies Record<ButtonSize, string>;

export function buttonClassNames({
  className,
  variant = 'primary',
  size = 'md',
  inline,
}: Pick<ButtonVisualProps, 'className' | 'variant' | 'size' | 'inline'>) {
  return classNames(
    'cc-button inline-flex shrink-0 items-center justify-center gap-1.5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:cursor-not-allowed disabled:opacity-50',
    inline ? 'w-auto' : '',
    variantClasses[variant],
    sizeClasses[size],
    className,
  );
}

export function Button({
  children,
  className,
  icon,
  tip,
  variant = 'primary',
  size = 'md',
  inline,
  loading,
  disabled,
  type = 'button',
  ref,
  ...props
}: ButtonProps) {
  const classes = buttonClassNames({ className, variant, size, inline });
  const content = (
    <>
      {loading ? <Spinner /> : icon}
      {children}
    </>
  );

  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={classes}
      title={tip ?? props.title}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {content}
    </button>
  );
}
