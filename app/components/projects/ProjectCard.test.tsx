import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectCard } from './ProjectCard';

function card(siteFramed: boolean) {
  return renderToStaticMarkup(
    <ProjectCard
      title="ff"
      updatedAt={null}
      siteUrl="https://theforbiddenfeminine.com/"
      siteFramed={siteFramed}
      primary={null}
      menuItems={null}
    />,
  );
}

describe('a project card', () => {
  it('names a site that refuses to be shown in a frame, rather than showing a blank one', () => {
    const markup = card(false);
    expect(markup).toContain('theforbiddenfeminine.com');
    expect(markup).not.toContain('Not published yet');
    expect(markup).toContain('Open site');
  });

  it('shows a site that allows it live', () => {
    expect(card(true)).not.toContain('>theforbiddenfeminine.com<');
  });
});
