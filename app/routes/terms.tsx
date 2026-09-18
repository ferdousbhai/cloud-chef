import { createFileRoute, Link } from '@tanstack/react-router';
import { TrustPage, TrustSection } from '~/components/trust/TrustPage';
import { CLOUDCHEF_OPERATOR, TRUST_PAGE_HEADINGS, createPublicBetaTrustPageHead } from '~/lib/trust';

export const Route = createFileRoute('/terms')({
  head: () =>
    createPublicBetaTrustPageHead({
      title: 'Terms | CloudChef',
      description: 'Public-beta terms for using CloudChef and customer-controlled Cloudflare resources.',
      path: '/terms',
    }),
  component: TermsPage,
});

// Operative wording is untouched here. Only the presentation changed: the clause series that state
// eligibility, billable charges, prohibited uses, and publisher responsibilities are rendered as the
// lists they already were, so a reader checking one clause no longer parses a sentence to find it.
function TermsPage() {
  return (
    <TrustPage
      title={TRUST_PAGE_HEADINGS.terms}
      summary="These terms govern the CloudChef public beta. The service can generate, validate, and deploy project code inside the Cloudflare account you authorize."
    >
      <TrustSection title="Operator, acceptance, and eligibility">
        <p>
          CloudChef is operated by {CLOUDCHEF_OPERATOR.legalName}, an {CLOUDCHEF_OPERATOR.legalForm} (Ontario
          Corporation No. {CLOUDCHEF_OPERATOR.registrationNumber}), with a business correspondence address at{' '}
          {CLOUDCHEF_OPERATOR.correspondenceAddress}. These Terms form an agreement between you and the operator. By
          connecting Cloudflare or using the signed-in service, you agree to these Terms.
        </p>
        <p>You must be:</p>
        <ul>
          <li>at least 18</li>
          <li>able to form a binding agreement</li>
          <li>authorized to act for any organization or Cloudflare account you use</li>
        </ul>
      </TrustSection>
      <TrustSection title="Public-beta service, availability, and costs">
        <p>
          CloudChef currently charges no fee for access during the public beta. Using it requires a compatible
          Cloudflare account, Workers Paid, and Containers. You are responsible for charges from Cloudflare, including:
        </p>
        <ul>
          <li>inference or prepaid AI Gateway credits</li>
          <li>storage</li>
          <li>Container compute</li>
          <li>builds</li>
          <li>network use</li>
          <li>deployed infrastructure</li>
        </ul>
        <p>CloudChef does not purchase credits or automatically change your Cloudflare plan.</p>
        <p>
          CloudChef uses AI and preview Cloudflare technology to generate, validate, preview, and deploy applications.
          It is pre-release software provided on an as-available basis and depends on Cloudflare and other third-party
          services with changing interfaces. Features may fail, change incompatibly, lose data, or become unavailable.
          No uptime, support, or emergency-response service level is promised.
        </p>
        <p>
          You authorize only the Cloudflare scopes shown during connection and must keep your CloudChef and Cloudflare
          access secure.
        </p>
      </TrustSection>
      <TrustSection title="Your inputs and generated output">
        <p>
          You keep your rights in prompts, files, and other material you provide. You give CloudChef a limited license
          to process, copy, transmit, and transform that material only as needed to provide, secure, troubleshoot, and
          maintain the service. You must have the rights and permissions needed to provide it.
        </p>
        <p>
          As between you and CloudChef, CloudChef claims no ownership in generated project output. AI output may not be
          unique or legally protectable and may be affected by third-party rights, open-source licenses, and service
          terms. Similar output may be generated for others.
        </p>
      </TrustSection>
      <TrustSection title="Generated applications and Cloudflare resources">
        <p>
          Generated code may contain mistakes, security issues, or unsuitable dependencies. Review, test, and monitor it
          before relying on it. Workers, D1 databases, R2 buckets, Containers, Durable Objects, Agents, and related
          resources are created in, controlled through, and billed to your Cloudflare account, subject to Cloudflare’s
          terms and third-party licenses.
        </p>
        <p>You are responsible for the applications you publish, including their:</p>
        <ul>
          <li>content</li>
          <li>users</li>
          <li>security</li>
          <li>monitoring</li>
          <li>legal notices</li>
          <li>data handling</li>
          <li>compliance</li>
        </ul>
        <p>
          Removing a project schedules cleanup of the generated resources associated with that project. Cleanup depends
          on your Cloudflare authorization remaining available and may be delayed or retried as described in the{' '}
          <Link to="/privacy">Privacy notice</Link>.
        </p>
      </TrustSection>
      <TrustSection title="Acceptable use">
        <p>Do not use CloudChef to:</p>
        <ul>
          <li>violate applicable law or third-party rights</li>
          <li>create or distribute malware</li>
          <li>access systems without authorization</li>
          <li>evade safeguards or rate limits</li>
          <li>expose credentials or personal data you are not authorized to process</li>
          <li>abuse Cloudflare or GitHub services</li>
          <li>
            build systems whose purpose is fraud, impersonation, harassment, exploitation, or facilitating physical harm
          </li>
        </ul>
        <p>
          Report prohibited use through the public <Link to="/support">Support</Link> form, which is also the abuse
          channel; there is no separate abuse address. Report a vulnerability in CloudChef through{' '}
          <Link to="/security">Security</Link> instead, so exploit details stay private.
        </p>
      </TrustSection>
      <TrustSection title="Suspension, termination, and data">
        <p>
          You may stop using CloudChef at any time and revoke its Cloudflare access. CloudChef may limit or suspend
          access when reasonably necessary for security, abuse prevention, legal compliance, service integrity, or a
          material breach of these Terms. Notice will be provided when reasonably practical. Stopping use, losing
          access, or revoking Cloudflare authorization does not by itself delete resources from your Cloudflare account,
          and the retention boundaries in the <Link to="/privacy">Privacy notice</Link> continue to apply.
        </p>
      </TrustSection>
      <TrustSection title="Warranty and liability">
        <p>
          To the maximum extent permitted by law, CloudChef is provided “as is” and “as available,” without implied
          warranties of merchantability, fitness for a particular purpose, non-infringement, or uninterrupted operation.
          You are responsible for reviewing generated code, maintaining backups, and controlling spending in your
          Cloudflare account.
        </p>
        <p>
          If you use CloudChef mainly for a trade, business, craft, or profession, then to the maximum extent permitted
          by law the operator will not be liable for indirect, incidental, special, consequential, exemplary, or
          punitive damages, or for lost profits, revenue, data, goodwill, or business interruption. For those business
          users, the operator’s aggregate liability arising from the service will not exceed the greater of C$100 and
          the amount paid directly to CloudChef during the 12 months before the event giving rise to the claim.
        </p>
        <p>
          If you use CloudChef as a consumer, your remedies and the operator’s liability are governed by the mandatory
          law that applies to you. The business-user exclusions and cap above do not replace those rights. Nothing in
          these Terms excludes liability for fraud, wilful misconduct, or any other liability that cannot lawfully be
          excluded or limited.
        </p>
      </TrustSection>
      <TrustSection title="Applicable law and disputes">
        <p>
          If you use CloudChef mainly for a trade, business, craft, or profession, these Terms are governed by the laws
          of Ontario and the federal laws of Canada applicable there, without regard to conflict-of-law rules. The
          courts in Toronto, Ontario have exclusive jurisdiction over disputes with those business users.
        </p>
        <p>
          If you use CloudChef as a consumer, these Terms do not take away mandatory rights, governing law, or courts
          available where you live. You may use <Link to="/support">Support</Link> to try to resolve a concern before
          filing a claim, but doing so is not a condition on any remedy or urgent relief available under applicable law.
        </p>
      </TrustSection>
      <TrustSection title="Changes, notices, and general terms">
        <p>
          Changes apply prospectively. When reasonably practical, material changes will be published on this page with
          an updated version, effective date, and advance notice before they take effect. Urgent changes needed for
          security, safety, legal compliance, or third-party platform requirements may take effect sooner.
        </p>
        <p>
          You may stop using CloudChef and revoke its Cloudflare authorization before a later effective date. Continued
          signed-in use after that date accepts the updated Terms where applicable law permits. Use{' '}
          <Link to="/support">Support</Link> for notices or questions.
        </p>
        <p>
          If any provision is unenforceable, the rest remains effective, and a failure to enforce a provision is not a
          waiver.
        </p>
      </TrustSection>
    </TrustPage>
  );
}
