import { describe, expect, test } from 'vitest';
import { readPage, renderLlmsTxt } from '../template/scripts/lib/llms-txt';

describe("generated app's /llms.txt", () => {
  test('reads a built page’s address, title and description', () => {
    const html = `<!doctype html><html><head>
      <meta content="Sign up for the &amp; spring  fair." name="description" />
      <title>Spring Fair</title></head><body></body></html>`;
    expect(readPage('index.html', html)).toEqual({
      path: '/',
      title: 'Spring Fair',
      description: 'Sign up for the & spring fair.',
    });
    expect(readPage('about/index.html', '<title>About</title>').path).toBe('/about/');
    expect(readPage('faq.html', '<title>FAQ</title>').path).toBe('/faq');
  });

  test('describes the app by its home page and lists every page', () => {
    expect(
      renderLlmsTxt([
        { path: '/faq', title: 'Questions', description: 'What people ask before the fair.' },
        { path: '/', title: 'Spring Fair', description: 'Sign up for the spring fair.' },
        { path: '/about/', title: 'About', description: 'Sign up for the spring fair.' },
      ]),
    ).toBe(
      [
        '# Spring Fair',
        '',
        '> Sign up for the spring fair.',
        '',
        '## Pages',
        '',
        '- [Home](/)',
        '- [About](/about/)',
        '- [Questions](/faq): What people ask before the fair.',
        '',
      ].join('\n'),
    );
  });

  test('writes nothing when no page has a title', () => {
    expect(renderLlmsTxt([])).toBeNull();
    expect(renderLlmsTxt([{ path: '/', title: '', description: 'x' }])).toBeNull();
  });
});
