import { createFileRoute, Link } from '@tanstack/react-router';
import { TrustPage, TrustPairs, TrustSection } from '~/components/trust/TrustPage';
import {
  CLOUDFLARE_SUPPORT_URL,
  GHOSTBUILD_SUPPORT_URL,
  TRUST_EMERGENCY_PAIR,
  TRUST_PAGE_HEADINGS,
  TRUST_RESPONSE_CAVEAT,
  createPublicBetaTrustPageHead,
} from '~/lib/trust';

export const Route = createFileRoute('/support')({
  head: () =>
    createPublicBetaTrustPageHead({
      title: 'Support | Ghostbuild',
      description: 'Get product, account, and privacy help for Ghostbuild.',
      path: '/support',
    }),
  component: SupportPage,
});

function SupportPage() {
  return (
    <TrustPage
      title={TRUST_PAGE_HEADINGS.support}
      summary="One public GitHub form handles product, Ghostbuild sign-in, privacy, and abuse requests. Everyone can read it, so post nothing you would not publish."
    >
      <TrustSection title="Open a support request">
        <p>
          <a className="trust-page__cta" href={GHOSTBUILD_SUPPORT_URL}>
            Create a GitHub support request
          </a>
        </p>
        {/* The one place the rule is stated. The sections below each used to restate it in their
            own words, which is how one instruction became four and the unique item in each got
            buried in the repetition. */}
        <p>Before posting, remove:</p>
        <ul>
          <li>personal data and identity documents</li>
          <li>prompts and source code</li>
          <li>tokens and credentials</li>
          <li>Cloudflare account identifiers</li>
        </ul>
        <TrustPairs items={[{ term: 'Acknowledgement', detail: 'Within two weekdays' }]} />
        <p>{TRUST_RESPONSE_CAVEAT} Acknowledgement is not resolution.</p>
      </TrustSection>
      <TrustSection title="Account and privacy requests">
        <p>
          Post only the request type and your GitHub handle. There is no verified confidential support or privacy inbox
          yet; if a private method can be arranged, a maintainer will name it there. Statutory deadlines govern
          privacy-rights requests whatever the target above says.
        </p>
      </TrustSection>
      <TrustSection title="Report abuse">
        <p>
          Abuse reports use the same form — there is no separate abuse address. Choose the abuse category, describe the
          prohibited use under the <Link to="/terms">Terms</Link>, and identify the affected Ghostbuild-generated site
          by its public URL only. Attach no evidence containing another person’s private content; a maintainer will ask
          for what is needed.
        </p>
        <p>
          Ghostbuild can act only on the service it operates. A deployed application’s content and behaviour live in the
          Cloudflare account that owns it, so serious cases may also need{' '}
          <a href={CLOUDFLARE_SUPPORT_URL}>Cloudflare support</a> or law enforcement.
        </p>
      </TrustSection>
      <TrustSection title="Not an emergency channel">
        <TrustPairs
          items={[
            TRUST_EMERGENCY_PAIR,
            {
              term: 'Compromised Cloudflare account',
              detail: (
                <>
                  <a href={CLOUDFLARE_SUPPORT_URL}>Cloudflare support</a>, which also handles an active Cloudflare
                  platform incident
                </>
              ),
            },
            {
              term: 'A vulnerability in Ghostbuild',
              detail: (
                <>
                  <Link to="/security">Security</Link>, so exploit details stay out of a public issue
                </>
              ),
            },
          ]}
        />
      </TrustSection>
    </TrustPage>
  );
}
