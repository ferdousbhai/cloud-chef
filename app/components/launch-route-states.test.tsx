import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    Link: ({ children, to, hash, reloadDocument: _reloadDocument, ...props }: LinkProps) => (
      <a {...props} href={`${to}${hash ? `#${hash}` : ''}`}>
        {children}
      </a>
    ),
    useNavigate: () => vi.fn(),
  };
});

type LinkProps = {
  children: React.ReactNode;
  to: string;
  hash?: string;
  reloadDocument?: boolean;
};

import { ProjectLoadError } from './ExistingChat.client';
import { ErrorDisplay } from './ErrorComponent';
import { WorkspacePreparingError } from '~/lib/cloudflare/client';

describe('launch route states', () => {
  it('replaces a failed cold project load with a retryable error instead of an endless spinner', () => {
    const html = renderToStaticMarkup(<ProjectLoadError error={new Error('Runtime unavailable')} onRetry={vi.fn()} />);

    expect(html).toContain('CloudChef could not load this project');
    expect(html).toContain('Runtime unavailable');
    expect(html).toContain('Try again');
    expect(html).not.toContain('Loading project');
  });

  it('tells a workspace that is still being prepared apart from a project that failed to load', () => {
    const preparing = renderToStaticMarkup(
      <ProjectLoadError error={new WorkspacePreparingError('messages.get')} onRetry={vi.fn()} />,
    );

    expect(preparing).toContain('CloudChef is still preparing your workspace');
    expect(preparing).toContain('takes a few minutes');
    expect(preparing).toContain('Keep waiting');
    // "Try again" restarts the same wait, so the preparing state must not offer it.
    expect(preparing).not.toContain('Try again');
    expect(preparing).not.toContain('could not load this project');
  });

  it('never reports a workspace that is not ready yet as a page that could not load', () => {
    const preparing = renderToStaticMarkup(<ErrorDisplay error={new WorkspacePreparingError('messages.get')} />);

    expect(preparing).toContain('CloudChef is still preparing your workspace');
    expect(preparing).toContain('Keep waiting');
    expect(preparing).not.toContain('This page could not load');
    expect(preparing).not.toContain('Try again');

    const unreachable = renderToStaticMarkup(
      <ErrorDisplay error={new Error('CloudChef timed out while running messages.get. Please try again.')} />,
    );

    expect(unreachable).toContain('This page could not load');
    expect(unreachable).toContain('Try again');
  });
});
