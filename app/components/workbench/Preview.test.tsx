import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Preview } from './Preview';

function render(site: Parameters<typeof Preview>[0]['site']) {
  return renderToStaticMarkup(<Preview site={site} reloadKey={0} />);
}

describe('Preview', () => {
  it('shows its live site beside the chat, with a link to open it', () => {
    const html = render({ url: 'https://alberta.ferdousbhai.com/', frameable: true, kind: 'live' });

    expect(html).toContain('Live site');
    expect(html).toContain('src="https://alberta.ferdousbhai.com/"');
    expect(html).toContain('Open in new tab');
    expect(html).not.toContain('Publish');
  });

  it('shows the preview this conversation made, named as one', () => {
    const html = render({ url: 'https://feature-x-site.example.workers.dev/', frameable: null, kind: 'preview' });

    expect(html).toContain('Preview of your changes');
    expect(html).toContain('<iframe');
  });

  it('links a site that refuses to be framed instead of showing a blank frame', () => {
    const html = render({ url: 'https://strict.example.com/', frameable: false, kind: 'live' });

    expect(html).toContain('can&#x27;t be shown here');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('href="https://strict.example.com/"');
  });

  it('says it is not published yet before it has a site', () => {
    const html = render(null);

    expect(html).toContain('Not published yet');
    expect(html).not.toContain('<iframe');
  });
});
