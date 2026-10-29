import { Link } from '@tanstack/react-router';
import { classNames } from '~/utils/classNames';

/** The terms a person agrees to by continuing, with the plan Cloudflare needs unless the page says so already. */
export function CloudflareConnectLegalNotice({
  className = '',
  planNote = true,
}: {
  className?: string;
  planNote?: boolean;
}) {
  return (
    <div className={classNames('cloudchef-connect-note', className)} data-testid="cloudflare-connect-legal-notice">
      {planNote ? <span>Workers Paid required.</span> : null}
      <p>
        By continuing, you agree to the <Link to="/terms">Terms</Link> and <Link to="/privacy">Privacy notice</Link>.
      </p>
    </div>
  );
}
