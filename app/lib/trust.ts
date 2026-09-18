import { createSocialPageHead } from './social-meta';

const CLOUDCHEF_REPOSITORY_URL = 'https://github.com/ferdousbhai/cloud-chef';
export const CLOUDCHEF_SUPPORT_URL = `${CLOUDCHEF_REPOSITORY_URL}/issues/new?template=support_request.yml`;
export const CLOUDCHEF_SECURITY_URL = `${CLOUDCHEF_REPOSITORY_URL}/security/advisories/new`;
export const CLOUDFLARE_SUPPORT_URL = 'https://developers.cloudflare.com/support/contacting-cloudflare-support/';
// Support and Security both open their escalation table with this row. One definition, so the two
// pages cannot answer "who do I call" differently.
export const TRUST_EMERGENCY_PAIR = { term: 'Immediate danger', detail: 'Local emergency services' } as const;
export const CLOUDCHEF_OPERATOR = {
  legalName: 'DOUS SOFTWARE INC.',
  legalForm: 'Ontario corporation',
  registrationNumber: '1001622428',
  correspondenceAddress: '350 Bay Street, Suite 1300B, Toronto, Ontario M5H 2S6, Canada',
} as const;

export const TRUST_DOCUMENT_VERSION = '1.7 public beta';
export const TRUST_DOCUMENT_EFFECTIVE_ISO_DATE = '2026-08-14';
export const TRUST_DOCUMENT_EFFECTIVE_DATE = 'August 14, 2026';
// A response target is data. The sentence this replaced recited both channels' numbers on both
// pages, next to each page's own restatement of its own number, so the same fact was on screen
// three times. Each page now renders its own rows and shares only the caveat.
export const TRUST_RESPONSE_CAVEAT =
  'Public-beta targets, not guarantees or contractual service levels. Channels are not monitored continuously, and CloudChef does not provide 24/7 or real-time emergency response.';
export const HOME_HERO_LEDE =
  'Describe the app. CloudChef writes, runs, and deploys it inside your own Cloudflare account.';

// The browser gate asserts these exact headings, so the pages and the suite
// read one definition instead of drifting apart.
export const TRUST_PAGE_HEADINGS = {
  privacy: 'How CloudChef handles your data.',
  terms: 'You control the cloud account.',
  support: 'Get help through the right channel.',
  security: 'Keep vulnerability details private.',
} as const;

/** Title strip on the landing-page composer, rendered as a decorative label. */
export const HOME_COMPOSER_TITLE = 'cloudchef ~ new project';

export const TRUST_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/support', label: 'Support' },
  { href: '/security', label: 'Security' },
] as const;

export function createPublicBetaTrustPageHead(options: { title: string; description: string; path: string }) {
  return createSocialPageHead({
    ...options,
    imagePath: '/social-preview-home-v3.png',
    imageAlt: 'CloudChef — build and ship Cloudflare apps',
  });
}
