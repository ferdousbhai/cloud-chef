import { createFileRoute, Link } from '@tanstack/react-router';
import { TrustPage, TrustPairs, TrustSection } from '~/components/trust/TrustPage';
import {
  GHOSTBUILD_SECURITY_URL,
  TRUST_PAGE_HEADINGS,
  TRUST_RESPONSE_CAVEAT,
  createPublicBetaTrustPageHead,
} from '~/lib/trust';

export const Route = createFileRoute('/security')({
  head: () =>
    createPublicBetaTrustPageHead({
      title: 'Security | Ghostbuild',
      description: 'Privately report a Ghostbuild vulnerability.',
      path: '/security',
    }),
  component: SecurityPage,
});

function SecurityPage() {
  return (
    <TrustPage
      title={TRUST_PAGE_HEADINGS.security}
      summary="Report a suspected vulnerability through GitHub private vulnerability reporting. Never put exploit details in a public support or bug issue."
    >
      <TrustSection title="Report privately">
        <p>
          <a className="trust-page__cta" href={GHOSTBUILD_SECURITY_URL}>
            Report a vulnerability privately
          </a>
        </p>
        <p>Include:</p>
        <ul>
          <li>the affected component</li>
          <li>the impact</li>
          <li>reproduction steps or a proof of concept</li>
          <li>a suggested mitigation, if you have one</li>
        </ul>
        <p>Remove credentials, personal data, and third-party secrets.</p>
      </TrustSection>
      <TrustSection title="Response and disclosure">
        <TrustPairs
          items={[
            { term: 'Acknowledgement', detail: 'Within one weekday' },
            { term: 'Initial triage update', detail: 'Within three weekdays' },
          ]}
        />
        <p>
          {TRUST_RESPONSE_CAVEAT} No fix date is promised. Coordinate public disclosure after affected users can be
          protected and a fix is available.
        </p>
      </TrustSection>
      <TrustSection title="Scope">
        <TrustPairs
          items={[
            { term: 'Covered', detail: 'Ghostbuild’s code repository and the service at ghostbuild.dev.' },
            {
              term: 'Not covered',
              detail:
                'Testing Cloudflare, GitHub, customer-controlled deployments, or other third-party systems is not authorized. Ghostbuild cannot bind third parties or law enforcement.',
            },
          ]}
        />
        <p>Test only accounts and resources you control. Do not:</p>
        <ul>
          <li>access, retain, or alter another person’s data</li>
          <li>disrupt service</li>
          <li>use social engineering</li>
          <li>create avoidable privacy, safety, or financial harm</li>
        </ul>
        <p>Stop and report if you encounter sensitive data.</p>
      </TrustSection>
      <TrustSection title="Not an incident channel">
        <p>Contain the incident first: revoke exposed credentials and Ghostbuild’s Cloudflare authorization.</p>
        <TrustPairs
          items={[
            {
              term: 'Compromised Cloudflare account',
              detail: (
                <a href="https://developers.cloudflare.com/support/contacting-cloudflare-support/">
                  Cloudflare support
                </a>
              ),
            },
            { term: 'Immediate danger', detail: 'Local emergency services' },
            { term: 'Everything else about Ghostbuild', detail: <Link to="/support">Support</Link> },
          ]}
        />
      </TrustSection>
    </TrustPage>
  );
}
