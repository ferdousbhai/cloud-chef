import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('renders allowed raw HTML only after sanitizing unsafe markup', () => {
    const markup = renderToStaticMarkup(
      <Markdown>
        {
          '<div class="__cloudchefThought__" onclick="alert(1)">Safe <strong>markup</strong></div><script>alert(2)</script>'
        }
      </Markdown>,
    );

    expect(markup).toContain('class="__cloudchefThought__"');
    expect(markup).toContain('<strong>markup</strong>');
    expect(markup).not.toContain('onclick');
    expect(markup).not.toContain('<script');
  });
});
