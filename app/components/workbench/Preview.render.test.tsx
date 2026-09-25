// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { idleBuilderPreviewState } from '~/agents/builder-preview-types';
import { previewPresentation } from '~/lib/common/preview-presentation';
import { Preview } from './Preview';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

it("labels the preview frame as the user's app so its crashes aren't mistaken for the workbench", async () => {
  const presentation = previewPresentation({
    ...idleBuilderPreviewState(),
    status: 'ready',
    published: {
      id: '12345678-1234-1234-1234-123456789abc',
      url: 'https://12345678-cloudchef-app.account.workers.dev',
      workspaceRevision: 7,
      snapshotRevision: 'snapshot-7',
      readyAt: '2026-08-06T19:00:00.000Z',
    },
  });
  await act(async () =>
    root.render(
      <Preview
        presentation={presentation}
        publication={null}
        reloadKey={0}
        requesting={false}
        onRequest={() => undefined}
        error={null}
      />,
    ),
  );

  expect(container.textContent).toContain('Your app');
  expect(container.textContent).toContain('Preview of revision 7');
  expect(container.querySelector('iframe')?.title).toBe('Your app: preview of revision 7');
});
