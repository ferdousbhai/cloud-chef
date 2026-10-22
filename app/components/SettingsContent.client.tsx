import { ArrowLeftIcon } from '@radix-ui/react-icons';
import { ProfileCard } from '~/components/settings/ProfileCard';
import { Toaster } from '~/components/ui/Toaster';
import { LinkButton } from '~/components/ui/LinkButton';
import { BrandLink } from '~/components/BrandLink';
import { CloudflareCard } from '~/components/settings/CloudflareCard.client';
import { AccountDataCard } from '~/components/settings/AccountDataCard.client';
import { AiRequestLogsCard } from '~/components/settings/AiRequestLogsCard.client';
import { ModelsCard } from '~/components/settings/ModelsCard.client';
import { OrganizationsCard } from '~/components/settings/OrganizationsCard.client';
import { TrustFooter } from '~/components/trust/TrustLinks';

export function SettingsContent({ authorizationError }: { authorizationError?: string | null }) {
  return (
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
          <div className="grid min-w-0 content-start gap-3">
            <ProfileCard />
            <CloudflareCard initialError={authorizationError} />
            <ModelsCard />
            <AiRequestLogsCard />
          </div>
          {/* Organizations hold the most controls (projects, people, requests): they get the wide column. */}
          <div className="grid min-w-0 content-start gap-3">
            <OrganizationsCard />
            <AccountDataCard />
          </div>
        </div>
      </div>
      <TrustFooter className="mt-4" />
      <Toaster />
    </div>
  );
}
