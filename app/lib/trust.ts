import { createSocialPageHead } from './social-meta';

const CLOUDCHEF_REPOSITORY_URL = 'https://github.com/ferdousbhai/cloud-chef';
export const CLOUDCHEF_SUPPORT_URL = `${CLOUDCHEF_REPOSITORY_URL}/issues/new?template=support_request.yml`;
export const CLOUDCHEF_SECURITY_URL = `${CLOUDCHEF_REPOSITORY_URL}/security/advisories/new`;
export const CLOUDFLARE_SUPPORT_URL = 'https://developers.cloudflare.com/support/contacting-cloudflare-support/';
// Support and Security both open their escalation table with this row. One definition, so the two
// pages cannot answer "who do I call" differently.
export const TRUST_EMERGENCY_PAIR = { term: 'Immediate danger', detail: 'Local emergency services' } as const;
export const CLOUDCHEF_OPERATOR = {
  legalName: 'SummonGhost, Inc.',
  legalForm: 'Delaware corporation',
  correspondenceAddress: '131 Continental Dr, Suite 305, Newark, Delaware 19713, United States',
} as const;

export const TRUST_DOCUMENT_VERSION = '1.13 public beta';
export const TRUST_DOCUMENT_EFFECTIVE_ISO_DATE = '2026-11-24';
export const TRUST_DOCUMENT_EFFECTIVE_DATE = 'November 23, 2026';
// A response target is data. The sentence this replaced recited both channels' numbers on both
// pages, next to each page's own restatement of its own number, so the same fact was on screen
// three times. Each page now renders its own rows and shares only the caveat.
export const TRUST_RESPONSE_CAVEAT =
  'Public-beta targets, not guarantees or contractual service levels. Channels are not monitored continuously, and CloudChef does not provide 24/7 or real-time emergency response.';
export const HOME_HEADING = 'What do you want to make?';
export const HOME_PITCH = 'Make software just for you, then share it with anyone.';

// Each trust page's visible heading.
export const TRUST_PAGE_HEADINGS = {
  privacy: 'Privacy',
  terms: 'Terms',
  support: 'Support',
  security: 'Security',
} as const;

export const TRUST_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/support', label: 'Support' },
  { href: '/security', label: 'Security' },
] as const;

export function createPublicBetaTrustPageHead(options: { title: string; description: string; path: string }) {
  return createSocialPageHead({
    ...options,
    imagePath: '/social-preview-home-v5.png',
    imageAlt: 'CloudChef — make your own software and share it',
  });
}
