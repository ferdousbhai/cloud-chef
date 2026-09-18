import { Link } from '@tanstack/react-router';

export function CloudflareConnectLegalNotice({ className = '' }: { className?: string }) {
  return (
    <p className={className} data-testid="cloudflare-connect-legal-notice">
      Workers Paid required. Connecting lets CloudChef create resources in your account and means you agree to the{' '}
      <Link to="/terms" className="underline underline-offset-4">
        Terms
      </Link>
      .{' '}
      <Link to="/privacy" className="underline underline-offset-4">
        Privacy
      </Link>
    </p>
  );
}
