import { createFileRoute, Link } from '@tanstack/react-router';
import { ClientTelemetryPreference } from '~/components/ClientRouteComponents';
import { TrustPage, TrustPairs, TrustSection } from '~/components/trust/TrustPage';
import { GHOSTBUILD_OPERATOR, TRUST_PAGE_HEADINGS, createPublicBetaTrustPageHead } from '~/lib/trust';

export const Route = createFileRoute('/privacy')({
  head: () =>
    createPublicBetaTrustPageHead({
      title: 'Privacy | Ghostbuild',
      description: 'How Ghostbuild handles account, workspace, deployment, and product data.',
      path: '/privacy',
    }),
  component: PrivacyPage,
});

// Operative wording is untouched here. Only the presentation changed: the record inventories and
// retention windows are rendered as the lists they already were, and the retention section — nine
// paragraphs answering four separate questions — is split under headings that name each question.
function PrivacyPage() {
  return (
    <TrustPage
      title={TRUST_PAGE_HEADINGS.privacy}
      summary="Ghostbuild’s own account stores only the records needed to authenticate you, connect Cloudflare, locate your user-owned runtime, and operate the service, plus narrow product telemetry if you opt in. Project and conversation data stays in the Cloudflare account you connect; the browser keeps only rebuildable in-memory views."
    >
      <TrustSection title="What Ghostbuild stores in its own account">
        <p>The operator control plane stores:</p>
        <ul>
          <li>your Cloudflare user identity and account details</li>
          <li>hashed authentication sessions</li>
          <li>encrypted OAuth credentials</li>
          <li>granted scopes and connection status</li>
          <li>user-runtime names and endpoints</li>
          <li>provisioning status</li>
          <li>narrow operational records</li>
        </ul>
        <p>It also holds sampled service logs and, only if you opt in, allowlisted product telemetry.</p>
        <p>The control-plane database does not store:</p>
        <ul>
          <li>prompt or transcript bodies</li>
          <li>project source</li>
          <li>deployment plans</li>
          <li>generated application data</li>
          <li>raw AI responses</li>
        </ul>
        <p>
          Chat catalogs, transcripts, generated files, workspace state, deployment records, and generated Cloudflare
          resources are stored in the connected Cloudflare account. Ghostbuild accesses them to perform your requests,
          but does not copy them into the operator control-plane database.
        </p>
      </TrustSection>

      <TrustSection title="Operator, scope, and roles">
        <p>
          {GHOSTBUILD_OPERATOR.legalName}, an {GHOSTBUILD_OPERATOR.legalForm} (Ontario Corporation No.{' '}
          {GHOSTBUILD_OPERATOR.registrationNumber}), operates Ghostbuild and is the controller for personal data
          Ghostbuild processes to operate the service. Its business correspondence address is{' '}
          {GHOSTBUILD_OPERATOR.correspondenceAddress}. This includes account, authentication, Cloudflare-connection,
          requested AI-building workflow, support, security, and optional product-telemetry processing. Persistent
          server-side project and conversation state remains in the connected Cloudflare account. You control that
          account and are responsible for processing performed by applications you publish. Cloudflare and GitHub also
          process data under their own terms and privacy roles.
        </p>
      </TrustSection>

      <TrustSection title="Data, purposes, and legal bases">
        <ul>
          <li>
            <strong>Account and authentication:</strong> Cloudflare identity, name, email, avatar, session records,
            OAuth state, and connection status. These are used to authenticate you and provide the service you request,
            including steps taken before and during the service agreement. The identity and authorization fields are
            required to use signed-in features; without them, Ghostbuild cannot provide those features.
          </li>
          <li>
            <strong>Cloudflare connection:</strong> account identifiers, granted scopes, runtime locators, and encrypted
            credentials. These are used to operate the Cloudflare integration you authorize. Tokens, ciphertext, IVs,
            credential handles, and capability secrets are excluded from account-data responses.
          </li>
          <li>
            <strong>Projects and conversations:</strong> chat metadata, transcripts, generated files, revisions,
            validation receipts, deployment plans, approvals, and deployment status. These are processed and stored in
            the connected Cloudflare account to generate, recover, validate, and deploy your project under the service
            agreement. You choose what project content to provide, but Ghostbuild cannot perform a requested build
            without the content needed for that request.
          </li>
          <li>
            <strong>Service and security logs:</strong> sampled Worker invocation, Container, and trace metadata can
            include request method and path, Cloudflare request metadata, response status, timing, binding activity, and
            exception or diagnostic metadata.
            <TrustPairs
              items={[
                { term: 'Ghostbuild control plane', detail: '60% of Worker logs and 5% of traces' },
                {
                  term: 'Workspace runtime, in your connected Cloudflare account',
                  detail: '60% of Worker logs, and Computer container logs enabled',
                },
                {
                  term: 'Generated applications, in your connected Cloudflare account',
                  detail: '60% of Worker logs and 5% of traces',
                },
              ]}
            />
            <p>
              These settings support operation, troubleshooting, and security under the operator’s legitimate interests.
              Prompts, source code, credentials, and raw tool output are not intended log fields.
            </p>
          </li>
          <li>
            <strong>Support, privacy, and legal records:</strong> contact details, message contents, attachments, case
            metadata, and reports you submit. These are used for the operator’s legitimate interests in answering
            requests, protecting users and infrastructure, enforcing the Terms, and establishing or defending legal
            claims, or to meet a legal obligation.
          </li>
          <li>
            <strong>Optional product telemetry:</strong> allowlisted events, opaque journey or error-event identifiers,
            status values, and bounded numeric metrics. Consent is requested before Ghostbuild sends this telemetry.
            Prompts, source code, credentials, URLs, and direct user identifiers are excluded. The request omits browser
            credentials; a client IP supplied by Cloudflare is used transiently as a rate-limit key and is not included
            in the application event log.
          </li>
        </ul>
      </TrustSection>

      <TrustSection title="AI processing">
        <p>
          The user-owned workspace runtime sends the prompt, conversation context, and project files needed for a
          request to the configured builder model through Cloudflare AI in the connected account. The in-chat model
          selector loads the current Cloudflare-hosted catalog from that account and offers models compatible with the
          builder’s function-calling and context requirements. Ghostbuild does not place prompt or source payloads in
          optional product telemetry. Paid-model calls are routed through the account’s default AI Gateway so accounts
          configured for Unified Billing can use prepaid credits; per-request controls skip AI Gateway caching and log
          collection. Cloudflare describes its handling of Workers AI content in its{' '}
          <a href="https://developers.cloudflare.com/workers-ai/platform/data-usage/">Workers AI data-usage notice</a>.
          Ghostbuild does not use AI to make decisions that produce legal or similarly significant effects about you.
        </p>
      </TrustSection>

      <TrustSection title="Browser storage and telemetry choice">
        <p>
          Essential browser storage includes a 30-day authentication cookie, short-lived OAuth and recovery state, theme
          and builder-model preferences, and a pending prompt in tab-scoped session storage. Chat, transcript, and
          workspace presentation caches remain only in memory and are rebuilt from your Cloudflare account after a
          reload. Preferences remain until replaced or cleared in your browser.
        </p>
        <p>
          Optional product telemetry is off until you allow it. Your choice is stored locally. Ghostbuild also honors
          Global Privacy Control and Do Not Track. Disabling telemetry stops future telemetry but does not remove events
          already received. You may withdraw telemetry consent at any time without affecting processing that occurred
          before withdrawal.
        </p>
        <ClientTelemetryPreference />
      </TrustSection>

      <TrustSection title="Where data is held and disclosed">
        <p>
          Workspace metadata, Agent transcripts, project files, Computer state, previews, and generated infrastructure
          remain in the connected Cloudflare account. Your browser may keep account-local transcript and project-file
          replicas. Data is disclosed only as needed to operate the service, follow your instructions, protect the
          service, or comply with law.
        </p>
        <p>
          Cloudflare provides authentication integration, Workers, D1, R2, Durable Objects, Containers, Computer,
          Workers AI, the Cloudflare AI model catalog, observability, and related infrastructure. GitHub processes
          information submitted through public support issues or private security reports. Control-plane observability
          is held in the operator’s Cloudflare account; workspace, Computer, and generated-application observability is
          held in your connected Cloudflare account. Ghostbuild does not sell personal data, share it for cross-context
          behavioral advertising, or use it for targeted advertising.
        </p>
      </TrustSection>

      <TrustSection title="International processing">
        <p>
          Cloudflare and GitHub operate globally, so data may be processed outside your country. Ghostbuild does not
          currently offer a selectable residency region. Cloudflare describes its transfer safeguards, including
          Standard Contractual Clauses where applicable, in its{' '}
          <a href="https://www.cloudflare.com/cloudflare-customer-dpa/">Data Processing Addendum</a>. Review{' '}
          <a href="https://www.cloudflare.com/policies/privacy/">Cloudflare’s Privacy Policy</a> and{' '}
          <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">
            GitHub’s privacy statement
          </a>
          , which describes GitHub’s international data-transfer practices.
        </p>
      </TrustSection>

      <TrustSection title="Retention in the operator control plane">
        <p>In the operator control plane:</p>
        <ul>
          <li>OAuth authorization state expires after 10 minutes</li>
          <li>authentication sessions after 30 days</li>
          <li>unreferenced encrypted credential records become eligible for removal after 24 hours</li>
        </ul>
        <p>
          Maintenance runs every 15 minutes in bounded batches, so backlog or retries can delay physical removal.
          Account, connection, and runtime-locator records remain while the account and service are active or until they
          are no longer needed or a verified request is fulfilled. There is no automatic inactive-account purge.
        </p>
        <p>
          The operator’s current Cloudflare plan retains sampled control-plane Workers Logs and traces for seven days.
          Ghostbuild does not copy them to another log or trace store. Cloudflare may retain aggregate control-plane
          Worker metrics for up to three months; those metrics are not a user-addressable event ledger.
        </p>
        <p>
          <a href="https://developers.cloudflare.com/d1/reference/time-travel/">Cloudflare D1 Time Travel</a> keeps
          control-plane database changes recoverable for up to 30 days under the current plan. User-owned D1 recovery
          windows depend on the user’s Cloudflare plan. Ghostbuild will not intentionally restore erased records from
          recovery history. If broader disaster recovery reintroduces them, the erasure must be reapplied unless a
          lawful retention exception governs.
        </p>
      </TrustSection>

      <TrustSection title="Erasing and exporting operator-held records">
        <p>Settings contains a self-service control that erases every record the operator holds for your account:</p>
        <ul>
          <li>identity and profile</li>
          <li>authentication sessions</li>
          <li>encrypted Cloudflare credentials</li>
          <li>connection metadata and granted scopes</li>
          <li>your runtime locator</li>
        </ul>
        <p>
          It also asks Cloudflare to revoke Ghostbuild’s authorization, and tells you when Cloudflare did not confirm
          that revocation so you can remove it yourself. Because erasure is irreversible it requires a Cloudflare
          sign-in completed in the last ten minutes, an exact typed confirmation, and an explicit acknowledgement of
          what is retained. Repeating it is harmless. If you have already revoked Ghostbuild’s authorization you can no
          longer sign in, so use the request path below instead.
        </p>
        <p>
          Settings also contains a self-service export of those same operator-held records. It saves a JSON file,
          carrying a schema version and an export timestamp, containing:
        </p>
        <ul>
          <li>your identity and profile</li>
          <li>your Cloudflare connection metadata and granted scopes</li>
          <li>the existence, storage time, and key version of your encrypted credential record</li>
          <li>your runtime locator</li>
          <li>your authentication-session and OAuth-state records</li>
        </ul>
        <p>
          Encrypted credential material, initialisation vectors, credential handles, and session token hashes are never
          exported. Because a single file discloses your whole account record, the export requires the same Cloudflare
          sign-in completed in the last ten minutes that erasure requires. Each section is bounded at 200 records and
          reports the untruncated count beside them, and a section that could not be read is named in the file, which
          reports itself incomplete rather than looking whole.
        </p>
      </TrustSection>

      <TrustSection title="What removal does not delete">
        <p>
          That control deliberately deletes nothing inside your own Cloudflare account.{' '}
          <strong>
            Workers and their unpromoted preview versions, production and preview D1 databases, R2 buckets, KV
            namespaces, Containers, Durable Objects, and Agents that Ghostbuild deployed are retained, keep running,
            keep billing to your account, and are yours to remove.
          </strong>{' '}
          Chats, transcripts, project files, and deployment records also stay there under that account’s controls, and
          the account export does not contain them: download individual project source with Download code in the project
          header, and use your Cloudflare account’s own tools for the rest. The browser holds no persistent chat,
          transcript, or project replica. Its theme, model, telemetry, cookie, and tab-session data are not reachable
          from the server and are in no export; Settings lists exactly what to clear.
        </p>
        <p>
          Workspace Worker and Computer container logs, and generated-application Worker logs and traces, remain in your
          connected Cloudflare account. Their access and retention follow that account’s permissions, plan, product
          settings, and Cloudflare controls. Ghostbuild does not copy them into the operator’s log or trace store, and
          removing a project does not immediately erase provider-retained observability.
        </p>
        <p>
          Removing a project hides it from the active project list and makes its Agent and workspace eligible for
          teardown no earlier than 30 minutes later. Ghostbuild also schedules deletion of the project’s generated
          Worker and all of its versions and Durable Objects, production and preview D1 databases, KV namespaces, and R2
          buckets from your connected Cloudflare account. R2 objects are emptied in bounded batches before the bucket is
          deleted; provider failures or revoked authorization can delay cleanup and are retried while access remains
          available. It is not complete erasure: catalog, transcript, deployment, provider-retained observability, and
          browser records remain under their applicable retention boundaries. You can download individual project source
          before removal, and browser data remains until you clear it.
        </p>
        <p>
          GitHub retains public support issues and private security reports according to its policies and repository
          controls. Records may also need to remain for security, fraud prevention, legal compliance, disputes, or
          backups.
        </p>
      </TrustSection>

      <TrustSection title="Your choices and rights">
        <p>
          Depending on applicable law, you may request access, correction, portability, restriction, objection, or
          erasure and may complain to the data-protection authority responsible where you live or where an alleged
          infringement occurred. Access to the records the operator holds, a machine-readable copy of them, and their
          erasure are all self-service in Settings, as described above. For everything else — correction, restriction,
          objection, data the operator does not hold, or a case the Settings controls cannot reach — start with the
          public <Link to="/support">Support</Link> form and include only the request type and your GitHub handle. If a
          private method can be arranged, a maintainer will identify it in the issue; until then, do not provide
          sensitive information. Ghostbuild does not yet provide a verified confidential privacy inbox.
        </p>
        <p>
          Ghostbuild may request proportionate information to verify control of the relevant Cloudflare identity before
          disclosing or deleting data. Public-beta response targets are not legal deadlines; where privacy law sets a
          deadline, including the GDPR’s usual one-month period, that deadline governs. Some rights and deletion
          requests are subject to lawful exceptions, and current technical limits are described above rather than
          treated as a waiver of those rights.
        </p>
      </TrustSection>

      <TrustSection title="Security and age limit">
        <p>
          Controls include encrypted Cloudflare credentials, hashed session and capability tokens, same-origin checks,
          short-lived runtime capabilities, tenant binding, bounded request sizes, deployment approval, and security
          readback. No system is risk-free. Ghostbuild is for adults and is not directed to anyone under 18; do not use
          the service if you are under 18.
        </p>
      </TrustSection>

      <TrustSection title="Changes and contact">
        <p>
          Material changes will be published with an updated version and effective date and, when practical, additional
          notice in the service. Use <Link to="/support">Support</Link> for privacy questions, sharing only the request
          type and your GitHub handle in the public form.
        </p>
      </TrustSection>
    </TrustPage>
  );
}
