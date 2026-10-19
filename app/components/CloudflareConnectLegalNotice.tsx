import { Link } from '@tanstack/react-router';
import { classNames } from '~/utils/classNames';

export function CloudflareConnectLegalNotice({
  className = '',
  signInLink = false,
}: {
  className?: string;
  /** Offer signing in without describing an app first (for the homepage's prompt). */
  signInLink?: boolean;
}) {
  return (
    <div className={classNames('cloudchef-connect-note', className)} data-testid="cloudflare-connect-legal-notice">
      <span>
        Workers Paid required.
        {signInLink ? (
          <>
            {' '}
            <Link to="/sign-in">Sign in</Link> without describing an app.
          </>
        ) : null}
      </span>
      <p>
        By connecting, you agree to the <Link to="/terms">Terms</Link>. <Link to="/privacy">Privacy</Link>
      </p>
    </div>
  );
}
