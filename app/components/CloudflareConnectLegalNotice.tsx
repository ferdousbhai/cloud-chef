import { Link } from '@tanstack/react-router';
import { classNames } from '~/utils/classNames';

export function CloudflareConnectLegalNotice({ className = '' }: { className?: string }) {
  return (
    <div className={classNames('cloudchef-connect-note', className)} data-testid="cloudflare-connect-legal-notice">
      <span>Workers Paid required.</span>
      <p>
        By connecting, you agree to the <Link to="/terms">Terms</Link>. <Link to="/privacy">Privacy</Link>
      </p>
    </div>
  );
}
