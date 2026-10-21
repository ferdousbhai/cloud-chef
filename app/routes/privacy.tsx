import { createFileRoute, Link } from '@tanstack/react-router';
import { ClientTelemetryPreference } from '~/components/ClientRouteComponents';
import { TrustPage, TrustPairs, TrustSection } from '~/components/trust/TrustPage';
import { CLOUDCHEF_OPERATOR, TRUST_PAGE_HEADINGS, createPublicBetaTrustPageHead } from '~/lib/trust';

export const Route = createFileRoute('/privacy')({
  head: () =>
    createPublicBetaTrustPageHead({
      title: 'Privacy | CloudChef',
      description: 'How CloudChef handles account, workspace, deployment, and product data.',
      path: '/privacy',
    }),
  component: PrivacyPage,
});

// The record inventories and retention windows are lists, and the retention section is split under
// headings that name each question it answers. The inventories must match what the control plane
// stores, erases, and exports (account-deletion.ts, account-export.ts).
function PrivacyPage() {
  return (
    <TrustPage
      title={TRUST_PAGE_HEADINGS.privacy}
      summary="CloudChef’s own account stores only the records needed to authenticate you, connect Cloudflare, locate your user-owned runtime, and operate the service, plus narrow product telemetry if you opt in. Project and conversation data stays in the Cloudflare account you build in: your own, or your team’s; the browser keeps only rebuildable in-memory views."
    >
      <TrustSection title="What CloudChef stores in its own account">
        <p>The operator control plane stores:</p>
        <ul>
          <li>your sign-in identity: Cloudflare, Google, or a verified email address</li>
          <li>your Cloudflare account details, if you connect one</li>
          <li>
            teams you belong to: their names, your role, whether you may build new apps of your own there, and invites
            sent to your address (with the role and projects they give)
          </li>
          <li>per-day counts of model turns and tokens used in a team&apos;s account</li>
          <li>
            a team&apos;s GitHub connection: the GitHub account CloudChef&apos;s GitHub App is installed on, the names
            of the repositories linked as its projects, and who may work on each
          </li>
          <li>
            production requests: a draft&apos;s title, note, preview URL, and its source files, kept with the request
            until an admin approves or declines it, then only its title, how many files it had, and the decision
          </li>
          <li>
            when you sent each team invite and created each team, kept for 30 days because they count toward the limits
            on invites and teams, even after the invite is revoked or the team deleted
          </li>
          <li>
            each account&apos;s model settings (the model new chats start on) and your choice whether AI Gateway logs
            your model requests
          </li>
          <li>hashed authentication sessions and emailed sign-in links</li>
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
          <li>project source, except a draft sent as a production request, until it is decided</li>
          <li>deployment plans</li>
          <li>generated application data</li>
          <li>raw AI responses</li>
        </ul>
        <p>
          Chat catalogs, transcripts, generated files, workspace state, deployment records, and generated Cloudflare
          resources are stored in the connected Cloudflare account. CloudChef accesses them to perform your requests,
          but does not copy them into the operator control-plane database; the one copy it keeps is a production
          request&apos;s draft, described under Teams.
        </p>
      </TrustSection>

      <TrustSection title="Operator, scope, and roles">
        <p>
          {CLOUDCHEF_OPERATOR.legalName}, an {CLOUDCHEF_OPERATOR.legalForm} (Ontario Corporation No.{' '}
          {CLOUDCHEF_OPERATOR.registrationNumber}), operates CloudChef and is the controller for personal data CloudChef
          processes to operate the service. Its business correspondence address is{' '}
          {CLOUDCHEF_OPERATOR.correspondenceAddress}. This includes account, authentication, Cloudflare-connection,
          requested AI-building workflow, support, security, and optional product-telemetry processing. Persistent
          server-side project and conversation state remains in the connected Cloudflare account. You control that
          account and are responsible for processing performed by applications you publish. Cloudflare and GitHub also
          process data under their own terms and privacy roles.
        </p>
      </TrustSection>

      <TrustSection title="Teams">
        <p>
          A team shares one Cloudflare account among the people its admins invite. Members sign in with Google or an
          emailed link and do not need Cloudflare logins of their own. Each member builds in a separate workspace in the
          team&apos;s account, so their chats, transcripts, project files, and deployed applications are stored there,
          under that account&apos;s controls. Its administrators, and anyone with access to that Cloudflare account, can
          read them, including the AI Gateway logs of each member&apos;s model requests, unless that member turned that
          logging off in Settings. Each member decides that for themselves; an admin cannot turn it back on. The team,
          not CloudChef&apos;s operator, decides how that account is used.
        </p>
        <p>
          Admins see each member&apos;s name, email, role, and this month&apos;s count of model turns and tokens in the
          team&apos;s account. Those counts contain no prompt, response, or project content. An admin can pause a
          member, who then cannot open their workspace or use the team&apos;s Cloudflare authorization, or remove them,
          which also deletes their workspace from the team&apos;s account and declines their open production requests;
          applications they deployed stay there. An admin can rename the team or delete it. Deleting a team deletes
          every member&apos;s workspace from its Cloudflare account, revokes CloudChef&apos;s authorization there, and
          removes the team&apos;s records from CloudChef: its members, invites, usage counts, GitHub connection, linked
          projects, and production requests. Applications deployed from it, with their databases and storage, stay in
          the Cloudflare account, and the repositories and CloudChef&apos;s GitHub App stay on GitHub until removed
          there.
        </p>
        <p>
          A team can also work on apps kept in GitHub. An admin installs CloudChef&apos;s GitHub App on the GitHub
          account that holds them and chooses which repositories it may reach. CloudChef stores the installation and
          which repositories are its projects, not their contents or any GitHub token: it fetches a project&apos;s files
          into the member&apos;s workspace and sends their changes back to GitHub as commits, with a short-lived token
          limited to that repository. When a member asks for a draft to become a project, its files are kept with the
          request until an admin approves it (and they go to the new GitHub repository) or declines it. GitHub&apos;s
          own terms and privacy statement govern the repositories.
        </p>
      </TrustSection>

      <TrustSection title="Data, purposes, and legal bases">
        <ul>
          <li>
            <strong>Account and authentication:</strong> your Cloudflare or Google identity or verified email, name,
            email, avatar, session records, sign-in links and OAuth state, connection status, and team memberships.
            These are used to authenticate you and provide the service you request, including steps taken before and
            during the service agreement. The identity and authorization fields are required to use signed-in features;
            without them, CloudChef cannot provide those features.
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
            agreement. You choose what project content to provide, but CloudChef cannot perform a requested build
            without the content needed for that request.
          </li>
          <li>
            <strong>Service and security logs:</strong> sampled Worker invocation, Container, and trace metadata can
            include request method and path, Cloudflare request metadata, response status, timing, binding activity, and
            exception or diagnostic metadata.
            <TrustPairs
              items={[
                { term: 'CloudChef control plane', detail: '60% of Worker logs and 5% of traces' },
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
            status values, and bounded numeric metrics. Consent is requested before CloudChef sends this telemetry.
            Prompts, source code, credentials, URLs, and direct user identifiers are excluded. The request omits browser
            credentials; a client IP supplied by Cloudflare is used transiently as a rate-limit key and is not included
            in the application event log.
          </li>
        </ul>
      </TrustSection>

      <TrustSection title="AI processing">
        <p>
          The user-owned workspace runtime sends the prompt, conversation context, and project files needed for a
          request to the selected builder model through Cloudflare AI in the connected account. The in-chat model
          selector loads the current Cloudflare-hosted catalog from that account and offers models compatible with the
          builder’s function-calling and context requirements. When the account’s default AI Gateway holds the account’s
          own key for an AI provider (Anthropic, OpenAI, xAI, or OpenRouter), whether an admin of the account (or, for
          your own account, you) added it in Cloudflare or pasted it in Settings, the selector also offers that
          provider’s models: those requests go from the same runtime through the account’s AI Gateway to that provider,
          which bills that key and handles the content under the account’s agreement with it. The key is kept in the
          account’s Cloudflare Secrets Store and attached to its AI Gateway; CloudChef passes a pasted key to Cloudflare
          once and never stores, logs, or reads it, and removing a key CloudChef added deletes it from the Secrets
          Store. A team’s admins also choose the model new chats start on. Every request goes through the account’s
          default AI Gateway. Unless you turn it off, the gateway logs each request in that account: what was sent (the
          prompt, conversation context, and project files) and the model’s reply, labelled with the conversation and the
          person who sent it, so the account can review what a conversation did. The logs follow AI Gateway’s retention
          settings in that account, and anyone with access to the account can read them, which for a team includes its
          admins; CloudChef’s operator receives no copy. You can turn this logging off under AI request logs in
          Settings. It is your own choice, wherever you build, and it applies to your later requests: they still go
          through the gateway but are not logged and carry no conversation or person label. Logs already recorded stay
          in the account until its AI Gateway retention removes them or someone with access deletes them in the
          Cloudflare dashboard. Accounts configured for Unified Billing use prepaid credits through the same gateway,
          and AI Gateway caching is skipped. Cloudflare describes its handling of Workers AI content in its{' '}
          <a href="https://developers.cloudflare.com/workers-ai/platform/data-usage/">Workers AI data-usage notice</a>.
          CloudChef does not use AI to make decisions that produce legal or similarly significant effects about you.
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
          Optional product telemetry is off until you allow it. Your choice is stored locally. CloudChef also honors
          Global Privacy Control and Do Not Track. Disabling telemetry stops future telemetry but does not remove events
          already received. You may withdraw telemetry consent at any time without affecting processing that occurred
          before withdrawal.
        </p>
        <ClientTelemetryPreference />
      </TrustSection>

      <TrustSection title="Where data is held and disclosed">
        <p>
          Workspace metadata, Agent transcripts, project files, Computer state, previews, and generated infrastructure
          remain in the connected Cloudflare account. Data is disclosed only as needed to operate the service, follow
          your instructions, protect the service, or comply with law.
        </p>
        <p>
          Cloudflare provides authentication integration, Workers, D1, R2, Durable Objects, Containers, Computer,
          Workers AI, AI Gateway, Secrets Store, the Cloudflare AI model catalog, observability, and related
          infrastructure. An AI provider (Anthropic, OpenAI, xAI, or OpenRouter) processes requests to its models only
          for an account whose AI Gateway holds that account’s own key for it, as that account’s provider. GitHub
          processes information submitted through public support issues or private security reports. Control-plane
          observability is held in the operator’s Cloudflare account; workspace, Computer, and generated-application
          observability is held in your connected Cloudflare account. CloudChef does not sell personal data, share it
          for cross-context behavioral advertising, or use it for targeted advertising.
        </p>
      </TrustSection>

      <TrustSection title="International processing">
        <p>
          Cloudflare and GitHub operate globally, so data may be processed outside your country. CloudChef does not
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
          <li>
            OAuth authorization and Google sign-in state expires after 10 minutes, GitHub installation state after 15
          </li>
          <li>emailed sign-in links after 15 minutes, and team invites after 7 days</li>
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
          CloudChef does not copy them to another log or trace store. Cloudflare may retain aggregate control-plane
          Worker metrics for up to three months; those metrics are not a user-addressable event ledger.
        </p>
        <p>
          <a href="https://developers.cloudflare.com/d1/reference/time-travel/">Cloudflare D1 Time Travel</a> keeps
          control-plane database changes recoverable for up to 30 days under the current plan. User-owned D1 recovery
          windows depend on the user’s Cloudflare plan. CloudChef will not intentionally restore erased records from
          recovery history. If broader disaster recovery reintroduces them, the erasure must be reapplied unless a
          lawful retention exception governs.
        </p>
      </TrustSection>

      <TrustSection title="Erasing and exporting operator-held records">
        <p>Settings contains a self-service control that erases every record the operator holds for your account:</p>
        <ul>
          <li>identity and profile</li>
          <li>authentication sessions and emailed sign-in links</li>
          <li>encrypted Cloudflare credentials</li>
          <li>connection metadata, granted scopes, and model settings</li>
          <li>your runtime locators and team memberships</li>
          <li>your production requests, and GitHub connections and approvals you started</li>
        </ul>
        <p>
          It also deletes your workspace in each team&apos;s Cloudflare account, as leaving the team would, and says
          which it could not reach. If you connected a Cloudflare account of your own, it asks Cloudflare to revoke
          CloudChef’s authorization, and tells you when Cloudflare did not confirm that revocation so you can remove it
          yourself. Because erasure is irreversible it requires a sign-in completed in the last ten minutes, an exact
          typed confirmation, and an explicit acknowledgement of what is retained. Erasure leaves a team&apos;s
          Cloudflare authorization alone while others still build in it; if you are its only remaining member, the team
          is removed and its authorization revoked too. If you are the only admin of a team others belong to, make
          someone else an admin first. Repeating it is harmless. If you sign in with Cloudflare and have already revoked
          CloudChef’s authorization, you can no longer sign in that way, so use the request path below instead.
        </p>
        <p>
          Settings also contains a self-service export of those same operator-held records. It saves a JSON file,
          carrying a schema version and an export timestamp, containing:
        </p>
        <ul>
          <li>your identity and profile, and whether your model requests are logged in AI Gateway</li>
          <li>your Cloudflare connection metadata, requested and granted scopes, and its default model</li>
          <li>the existence, storage time, and key version of your encrypted credential record</li>
          <li>your runtime locators</li>
          <li>your team memberships, invites addressed to you, and your daily usage counts</li>
          <li>
            the GitHub projects you were given, and the production requests you sent, with a draft&apos;s source while
            CloudChef still holds it
          </li>
          <li>GitHub connections and approvals you started, and sign-in links emailed to you</li>
          <li>your authentication-session and OAuth-state records</li>
        </ul>
        <p>
          Encrypted credential material, initialisation vectors, credential handles, session token hashes, and the
          hashes and states that sign-in links, invites, and authorizations in progress are checked against are never
          exported. Because a single file discloses your whole account record, the export requires the same sign-in
          completed in the last ten minutes that erasure requires. Each section is bounded at 200 records and reports
          the untruncated count beside them, and a section that could not be read is named in the file, which reports
          itself incomplete rather than looking whole.
        </p>
      </TrustSection>

      <TrustSection title="What removal does not delete">
        <p>
          That control deliberately deletes nothing inside your own Cloudflare account, and nothing in a team&apos;s but
          your workspace there.{' '}
          <strong>
            Workers and their unpromoted preview versions, production and preview D1 databases, R2 buckets, KV
            namespaces, Containers, Durable Objects, and Agents that CloudChef deployed are retained, keep running, keep
            billing to your account, and are yours to remove.
          </strong>{' '}
          Chats, transcripts, project files, and deployment records also stay there under that account’s controls, and
          the account export does not contain them: download individual project source with Download code in the project
          header, and use your Cloudflare account’s own tools for the rest. The browser holds no persistent chat,
          transcript, or project replica. Its theme, model, telemetry-choice, and tab-session data are not reachable
          from the server and are in no export; the authentication cookie is sent with requests so the server can verify
          sign-in. Settings lists exactly what to clear.
        </p>
        <p>
          Workspace Worker and Computer container logs, AI Gateway request logs (when you have not turned them off), and
          generated-application Worker logs and traces, remain in your connected Cloudflare account. Their access and
          retention follow that account’s permissions, plan, product settings, and Cloudflare controls. CloudChef does
          not copy them into the operator’s log or trace store, and removing a project does not immediately erase
          provider-retained observability.
        </p>
        <p>
          Removing a project hides it from the active project list and makes its Agent and workspace eligible for
          teardown no earlier than 30 minutes later. CloudChef also schedules deletion of the project’s generated Worker
          and all of its versions and Durable Objects, production and preview D1 databases, KV namespaces, and R2
          buckets from your connected Cloudflare account. R2 objects are emptied in bounded batches before the bucket is
          deleted; provider failures or revoked authorization can delay cleanup and are retried while access remains
          available. It is not complete erasure: catalog, transcript, deployment, provider-retained observability, and
          browser records remain under their applicable retention boundaries. Browser data remains until you clear it.
          Delete projects and allow this cleanup to finish before deleting your CloudChef account data: account deletion
          revokes the authorization cleanup needs, so a project deleted inside this window keeps running and billing
          until you remove its resources in your Cloudflare account.
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
          sensitive information. CloudChef does not yet provide a verified confidential privacy inbox.
        </p>
        <p>
          CloudChef may request proportionate information to verify control of the relevant sign-in identity
          (Cloudflare, Google, or an email address) before disclosing or deleting data. Public-beta response targets are
          not legal deadlines; where privacy law sets a deadline, including the GDPR’s usual one-month period, that
          deadline governs. Some rights and deletion requests are subject to lawful exceptions, and current technical
          limits are described above rather than treated as a waiver of those rights.
        </p>
      </TrustSection>

      <TrustSection title="Security and age limit">
        <p>
          Controls include encrypted Cloudflare credentials, hashed session and capability tokens, same-origin checks,
          short-lived runtime capabilities, tenant binding, bounded request sizes, deployment approval, and security
          readback. No system is risk-free. CloudChef is for adults and is not directed to anyone under 18, who must not
          use the service.
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
