import { useState } from 'react';
import { ArrowLeftIcon } from '@radix-ui/react-icons';
import { BrandLink } from '~/components/BrandLink';
import { Button } from '@ui/Button';
import { LinkButton } from '~/components/ui/LinkButton';
import { createCloudflareReturnURL, signInWithCloudflare } from '~/lib/auth-client';
import { CloudflareConnectLegalNotice } from '~/components/CloudflareConnectLegalNotice';

export function CloudflareSignInPrompt({
  title,
  description,
  initialError = null,
}: {
  title: string;
  description?: string;
  initialError?: string | null;
}) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      await signInWithCloudflare(createCloudflareReturnURL());
    } catch (connectionError) {
      setError(connectionError instanceof Error ? connectionError.message : 'Unable to connect Cloudflare.');
      setConnecting(false);
    }
  };

  return (
    <div className="app-page-shell flex min-h-full items-center px-4 py-6">
      <section className="app-error-card app-card mx-auto" aria-labelledby="cloudflare-sign-in-heading">
        <BrandLink />
        <h1 id="cloudflare-sign-in-heading" className="app-page-title mt-4 !text-2xl">
          {title}
        </h1>
        {description ? <p className="app-page-lede">{description}</p> : null}
        {error && (
          <p className="mt-4 text-sm text-content-error" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button loading={connecting} onClick={() => void connect()}>
            Connect Cloudflare
          </Button>
          <LinkButton to="/" variant="neutral" icon={<ArrowLeftIcon aria-hidden />}>
            Back to CloudChef
          </LinkButton>
        </div>
        <CloudflareConnectLegalNotice className="mt-4" />
      </section>
    </div>
  );
}
