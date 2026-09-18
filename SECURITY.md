# Security Policy

## Supported Versions

CloudChef is deployed continuously from `main`. Security fixes are made on `main`; older commits and generated
applications are not maintained as separate release lines.

## Reporting a Vulnerability

Do not open a public issue or pull request for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/ferdousbhai/cloud-chef/security/advisories/new) and
include the affected component, impact, reproduction steps or proof of concept, and any suggested mitigation. Remove
credentials, personal data, and other third-party secrets from the report.

CloudChef aims to review and acknowledge a report within one weekday and provide an initial triage update within three
weekdays. These are public-beta targets, not guarantees, contractual service levels, or a promise that a fix will be
available by a particular date. This channel is not monitored continuously and must not be relied on for immediate
incident containment. Revoke exposed credentials and CloudChef's Cloudflare authorization first, and use Cloudflare
support for a compromised Cloudflare account.

This policy covers CloudChef's code repository and the service at `cloudchef.build`. It does not authorize testing
Cloudflare, GitHub, customer-controlled deployments, or other third-party systems. Test only accounts and resources you
control. Do not access, retain, or alter another person's data; disrupt service; use social engineering; or create
avoidable privacy, safety, or financial harm. Stop and report if you encounter sensitive data. CloudChef cannot bind
third parties or law enforcement.

Please do not disclose the issue publicly before affected users can be protected and an appropriate fix is available.
