import { TRUST_LINKS } from '~/lib/trust';
import { Link } from '@tanstack/react-router';

export function TrustLinks({ className = '' }: { className?: string }) {
  return (
    <nav
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-content-tertiary ${className}`}
      aria-label="Trust and legal"
    >
      {TRUST_LINKS.map(({ href, label }) => (
        <Link
          key={href}
          to={href}
          className="rounded-sm underline decoration-transparent underline-offset-4 transition hover:decoration-current focus-visible:decoration-current"
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function TrustFooter({ className = '' }: { className?: string }) {
  return (
    <footer className={`border-t border-bolt-elements-borderColor px-4 py-2.5 sm:px-6 ${className}`}>
      {/* One row, and no prose: "your Cloudflare account controls generated resources" said the
          same thing the hero lede already says, and a claim made twice reads as noise rather than
          reassurance. */}
      <div className="mx-auto flex w-full max-w-[1080px] flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="text-xs text-content-tertiary">
          <a className="underline underline-offset-4" href="https://github.com/ferdousbhai/cloud-chef">
            Open source
          </a>{' '}
          ·{' '}
          <a
            className="underline underline-offset-4"
            href="https://github.com/sponsors/ferdousbhai?metadata_campaign=cloudchef-app"
          >
            Sponsor
          </a>
        </p>
        <TrustLinks />
      </div>
    </footer>
  );
}
