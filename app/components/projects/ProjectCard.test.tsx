import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectCard, type CardDeploy } from './ProjectCard';

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

function published(deploy: CardDeploy, siteUrl: string | null = null) {
  return renderToStaticMarkup(
    <ProjectCard title="Shop" updatedAt={null} siteUrl={siteUrl} deploy={deploy} primary={null} menuItems={null} />,
  );
}

const noop = () => undefined;

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

describe('a project card for a project CloudChef publishes', () => {
  it.each(['queued', 'building', 'deploying', 'superseded'] as const)('says it is publishing while %s', (state) => {
    const markup = published({ state, reason: null });
    expect(markup).toContain('Publishing…');
    expect(markup).toContain('animate-spin');
    expect(markup).not.toContain('Not published yet');
  });

  it('keeps the site in view while a new version is published, with a note that it is updating', () => {
    const markup = published({ state: 'building', reason: null }, 'https://shop.example.com');
    expect(markup).toContain('Updating…');
    expect(markup).not.toContain('Publishing…');
    expect(markup).toContain('Open site');
  });

  it('shows the site once published, with nothing more to say', () => {
    const markup = published({ state: 'succeeded', reason: null }, 'https://shop.example.com');
    expect(markup).toContain('Open site');
    expect(markup).not.toMatch(/Updating|Publishing|Didn&#x27;t publish|Code only/);
  });

  it("says it didn't publish and why, with a way to try again and to see what happened", () => {
    const markup = published({
      state: 'failed',
      reason: 'The build stopped with an error.',
      onRetry: noop,
      onShowLog: noop,
    });
    expect(markup).toContain('Didn&#x27;t publish');
    expect(markup).toContain('The build stopped with an error.');
    expect(markup).toContain('Try again');
    expect(markup).toContain('Show what happened');
  });

  it('offers no Try again to someone who may only view the project', () => {
    const markup = published({ state: 'failed', reason: null, onShowLog: noop });
    expect(markup).not.toContain('Try again');
    expect(markup).toContain('Show what happened');
  });

  it('says a project with nothing to publish is code only, and why', () => {
    const markup = published({ state: 'not_deployable', reason: 'There is no app here to publish.' });
    expect(markup).toContain('Code only');
    expect(markup).toContain('There is no app here to publish.');
    expect(markup).not.toContain('Not published yet');
  });

  it('says it is not published yet before its first publish', () => {
    expect(published({ state: null, reason: null })).toContain('Not published yet');
  });
});
