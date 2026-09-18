# Contact-channel operations

This is the operating record for CloudChef's public-beta contact channels. It is not an uptime or response-time
service-level agreement.

## Channel map

| Concern                | Published route                 | Provisioned or private route                                    | Primary owner | Coverage                                                  |
| ---------------------- | ------------------------------- | --------------------------------------------------------------- | ------------- | --------------------------------------------------------- |
| Product support        | GitHub support issue            | `support@cloudchef.build` (enabled, unpublished; drill pending) | `ferdousbhai` | Twice each weekday; no 24/7 coverage                      |
| Privacy rights         | Sanitized GitHub request start  | `privacy@cloudchef.build` (enabled, unpublished; drill pending) | `ferdousbhai` | Twice each weekday; statutory deadlines govern            |
| Security vulnerability | `/security` (no report details) | GitHub private vulnerability reporting                          | `ferdousbhai` | One-weekday acknowledgement target; no emergency response |

The email aliases use Cloudflare Email Routing and forward to an already-verified HEY destination. Catch-all routing is
disabled. The destination address is private operational configuration and must not be committed or exposed in reports.
The aliases are provisioned but must not be published or treated as intake channels until an external receive/reply
drill passes. They are inbound-only; a reply may come from the private mailbox address until branded outbound mail is
configured. Once activated, requesters must be told that email is not end-to-end encrypted and not to send credentials,
recovery codes, identity documents, exploit payloads, or unnecessary project content.

## Checked configuration

On August 4, 2026:

- Cloudflare reported Email Routing `enabled` and `ready` for `cloudchef.build`.
- Exact enabled forwarding rules existed for `support@` and `privacy@`; catch-all remained disabled/drop.
- Both Cloudflare authoritative nameservers, 1.1.1.1, and 8.8.8.8 returned all three Cloudflare MX records. SPF and
  Cloudflare DKIM records were also present.
- GitHub private vulnerability reporting was enabled.
- The GitHub support form assigned new issues to `ferdousbhai`.
- The owner account subscribed to repository activity; an external notification-delivery drill remains pending.

An external send/receipt/reply drill is still required for both aliases. Send from an address different from the forwarding
destination, confirm receipt and reply behavior, and record only the date, channel, result, and owner here—never message
contents or the private destination address. Do not advertise either alias until its drill passes.

GitHub repository watching is enabled, but web/email notification delivery is not yet verified. Until it is, the primary
owner must manually inspect open support issues and private vulnerability reports during both weekday inbox checks.
There is no backup owner during the one-person public beta.

## Intake procedure

The email-specific steps below apply only after the relevant alias has been activated.

1. Assign an opaque case identifier and record the received time, channel, request type, and owner in the private
   mailbox. Do not copy message content into public issues or repository files.
2. Remove or avoid collecting material that is not needed to handle the request. Never request credentials or recovery
   codes.
3. For an access, portability, correction, or deletion request, verify the requester against the email on the relevant
   Cloudflare-authenticated CloudChef account. If the sender differs, send a minimal challenge to the stored address.
   Escalate uncertain or high-risk identity cases rather than disclosing data.
4. Acknowledge against the published target, state what happens next, and track the controlling statutory deadline
   separately. The public-beta target never extends a legal deadline.
5. Route immediate danger to local emergency services, compromised Cloudflare accounts to Cloudflare Support, and
   vulnerabilities to GitHub private reporting.
6. Close only after recording the action and any lawful retention exception. Review closed support email after 90 days;
   delete it when it is no longer needed. Minimize privacy and security case content and review it annually while
   a legal, safety, fraud, or claims need remains.

For every privacy-rights case, the private case record must contain the received date, controlling statutory deadline,
opaque case ID, stored-account-email challenge result, systems in scope, secret fields excluded, action evidence, any
lawful exception, and the closure date. Do not close an access or deletion request until every inventoried system has
been handled, identified as user-controlled with clear instructions, or covered by a documented lawful or technical
limitation communicated to the requester. A control-plane D1 deletion can remain provider-recoverable for up to 30 days;
if disaster recovery reintroduces fulfilled deletion data, reapply the deletion unless a lawful exception governs.

## Remaining operator actions

- Confirm receipt and reply for both aliases from a different external mailbox.
- Verify GitHub web/email notification delivery with harmless test reports.
- Configure a backup owner before claiming holiday, illness, or continuous coverage.
