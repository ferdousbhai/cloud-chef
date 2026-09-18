import { Link } from '@tanstack/react-router';

export function CloudflareConnectLegalNotice({ className = '' }: { className?: string }) {
  return (
    <div className={className} data-testid="cloudflare-connect-legal-notice">
      {/* Stated before the grant, not after it: a workspace runs on Cloudflare Containers, and an
          account without Workers Paid cannot run one no matter what it authorizes here. */}
      <p>
        CloudChef runs your workspace on Cloudflare Containers, which requires the Workers Paid plan on the account you
        connect.
      </p>
      <p className="mt-1">
        By connecting, you authorize CloudChef to create and use project resources in this Cloudflare account as
        described in the{' '}
        <Link to="/privacy" className="underline underline-offset-4">
          Privacy notice
        </Link>{' '}
        and agree to the{' '}
        <Link to="/terms" className="underline underline-offset-4">
          Terms
        </Link>
        .
      </p>
    </div>
  );
}
