import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';
import { ProjectTitle } from '~/components/ProjectTitle';
import styles from './Markdown.module.css';

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

  it('renders a reply in its styled block: headings, inline marks, links, nested lists, tables, quotes and code', () => {
    const markup = renderToStaticMarkup(
      <Markdown>
        {[
          '# Title',
          '',
          'Some **bold**, *em*, ~~del~~ and `code` with a [link](https://example.com).',
          '',
          '- one',
          '- two',
          '  1. nested',
          '',
          '| a | b |',
          '|---|---|',
          '| 1 | 2 |',
          '',
          '> quote',
          '',
          '```ts',
          'const x = 1;',
          '```',
        ].join('\n')}
      </Markdown>,
    );

    expect(markup.startsWith(`<div class="${styles.MarkdownContent}"><h1>Title</h1>`)).toBe(true);
    expect(markup).toContain(
      '<p>Some <strong>bold</strong>, <em>em</em>, <del>del</del> and <code>code</code> with a <a href="https://example.com">link</a>.</p>',
    );
    expect(markup).toContain('<li>two\n<ol>\n<li>nested</li>\n</ol>\n</li>');
    expect(markup).toContain(
      '<div class="max-w-full overflow-x-auto" tabindex="0" role="region" aria-label="Table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>',
    );
    expect(markup).toContain('<blockquote>\n<p>quote</p>\n</blockquote>');
    expect(markup).toContain('aria-label="Copy code"');
    expect(markup).toContain('const x = 1;');
  });

  it('renders a project title inline, keeping only its emphasis and code', () => {
    expect(renderToStaticMarkup(<ProjectTitle>{'**My** _app_ `x`'}</ProjectTitle>)).toBe(
      '<span><strong>My</strong> <em>app</em> <code class="rounded bg-[var(--cc-background-secondary)] px-1 py-0.5 font-mono">x</code></span>',
    );
  });
});
