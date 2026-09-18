import { ArrowLeftIcon } from '@radix-ui/react-icons';
import { ProfileCard } from '~/components/settings/ProfileCard';
import { Toaster } from '~/components/ui/Toaster';
import { UserProvider } from '~/components/UserProvider';
import { LinkButton } from '~/components/ui/LinkButton';
import { BrandLink } from '~/components/BrandLink';
import { CloudflareCard } from '~/components/settings/CloudflareCard.client';
import { AccountDataCard } from '~/components/settings/AccountDataCard.client';
import { TrustFooter } from '~/components/trust/TrustLinks';

export function SettingsContent({ authorizationError }: { authorizationError?: string | null }) {
  return (
    <UserProvider>
      <div className="app-page-shell">
        <div className="app-page-container settings-container">
          <nav className="app-page-nav !mb-4" aria-label="Settings navigation">
            <BrandLink />
            <LinkButton to="/" variant="neutral" size="sm" icon={<ArrowLeftIcon aria-hidden />}>
              <span>
                <span className="hidden sm:inline">Back to </span>builder
              </span>
            </LinkButton>
          </nav>

          <h1 className="sr-only">Settings</h1>

          <div className="app-page-content !mt-0 settings-grid">
            <div className="grid content-start gap-3">
              <ProfileCard />
              <CloudflareCard initialError={authorizationError} />
            </div>
            <AccountDataCard />
          </div>
        </div>
        <TrustFooter className="mt-4" />
        <Toaster />
      </div>
    </UserProvider>
  );
}
