import { createSocialPageHead } from './social-meta';

const GHOSTBUILD_REPOSITORY_URL = 'https://github.com/ferdousbhai/ghost-build';
export const GHOSTBUILD_SUPPORT_URL = `${GHOSTBUILD_REPOSITORY_URL}/issues/new?template=support_request.yml`;
export const GHOSTBUILD_SECURITY_URL = `${GHOSTBUILD_REPOSITORY_URL}/security/advisories/new`;
export const GHOSTBUILD_OPERATOR = {
  legalName: 'DOUS SOFTWARE INC.',
  legalForm: 'Ontario corporation',
  registrationNumber: '1001622428',
  correspondenceAddress: '350 Bay Street, Suite 1300B, Toronto, Ontario M5H 2S6, Canada',
} as const;

export const TRUST_DOCUMENT_VERSION = '1.7 public beta';
export const TRUST_DOCUMENT_EFFECTIVE_ISO_DATE = '2026-08-14';
export const TRUST_DOCUMENT_EFFECTIVE_DATE = 'August 14, 2026';
export const TRUST_DOCUMENT_STATUS =
  'These pages describe the current service, its public-beta limitations, and the channels that are actually available.';
export const TRUST_CHANNEL_STATUS =
  'Ghostbuild aims to review and acknowledge requests submitted through its published support form within two weekdays and private security reports within one weekday. These public-beta targets are not guarantees or contractual service levels. Channels are not monitored continuously, and Ghostbuild does not provide 24/7 or real-time emergency response.';
export const HOME_HERO_LEDE =
  'Describe the app. Ghostbuild writes, runs, and deploys it inside your own Cloudflare account — the code, data, and infrastructure stay yours.';

// The browser gate asserts these exact headings, so the pages and the suite
// read one definition instead of drifting apart.
export const TRUST_PAGE_HEADINGS = {
  privacy: 'How Ghostbuild handles your data.',
  terms: 'You control the cloud account.',
  support: 'Get help through the right channel.',
  security: 'Keep vulnerability details private.',
} as const;

/** Title strip on the landing-page composer, rendered as a decorative label. */
export const HOME_COMPOSER_TITLE = 'ghostbuild ~ new project';

export const TRUST_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/support', label: 'Support' },
  { href: '/security', label: 'Security' },
] as const;

export function createPublicBetaTrustPageHead(options: { title: string; description: string; path: string }) {
  return createSocialPageHead({
    ...options,
    imagePath: '/social-preview-home-v2.png',
    imageAlt: 'Ghostbuild — build and ship Cloudflare apps',
  });
}
