const CLOUDCHEF_ORIGIN = 'https://cloudchef.build';
const SOCIAL_IMAGE_WIDTH = '1200';
const SOCIAL_IMAGE_HEIGHT = '630';

interface SocialPageHeadOptions {
  title: string;
  description: string;
  path: string;
  imagePath: string;
  imageAlt: string;
}

export function createSocialPageHead({ title, description, path, imagePath, imageAlt }: SocialPageHeadOptions) {
  const url = new URL(path, CLOUDCHEF_ORIGIN).toString();
  const image = new URL(imagePath, CLOUDCHEF_ORIGIN).toString();

  return {
    meta: [
      { title },
      { name: 'description', content: description },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'CloudChef' },
      { property: 'og:url', content: url },
      { property: 'og:image', content: image },
      { property: 'og:image:type', content: 'image/png' },
      { property: 'og:image:width', content: SOCIAL_IMAGE_WIDTH },
      { property: 'og:image:height', content: SOCIAL_IMAGE_HEIGHT },
      { property: 'og:image:alt', content: imageAlt },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: description },
      { name: 'twitter:image', content: image },
      { name: 'twitter:image:alt', content: imageAlt },
    ],
    links: [{ rel: 'canonical', href: url }],
  };
}

export function createPrivatePageHead(title: string, description: string) {
  return {
    meta: [{ title }, { name: 'description', content: description }, { name: 'robots', content: 'noindex, nofollow' }],
  };
}
