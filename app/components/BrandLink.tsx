import { classNames } from '~/utils/classNames';
import { Link } from '@tanstack/react-router';

export function BrandLink({
  className,
  nameClassName,
  variant = 'page',
}: {
  className?: string;
  nameClassName?: string;
  variant?: 'page' | 'header';
}) {
  return (
    <Link
      to="/"
      reloadDocument={variant === 'header'}
      className={classNames({ 'app-brand-lockup': variant === 'page' }, className)}
      aria-label="CloudChef home"
    >
      <span className="cloudchef-brand-mark" aria-hidden>
        <img src="/cloudchef-logo.svg?v=2" alt="" width={30} height={30} />
      </span>
      <span className={nameClassName}>CloudChef</span>
    </Link>
  );
}
