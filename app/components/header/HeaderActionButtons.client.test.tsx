import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatStore } from '~/lib/stores/workspaceId';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { HeaderActionButtons } from './HeaderActionButtons.client';

/** A phone-width window, as the viewport hook reads it on its first render. */
beforeEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: 390 } });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
  chatStore.setKey('started', false);
  workbenchStore.showWorkbench.set(false);
});

describe('the small-screen workspace switcher', () => {
  it('is not shown before a chat starts while no code is open', () => {
    expect(renderToStaticMarkup(<HeaderActionButtons />)).toBe('');
  });

  it("offers the preview beside code a team project's first screen opened, before any message", () => {
    workbenchStore.currentView.set('code');
    workbenchStore.showWorkbench.set(true);
    const markup = renderToStaticMarkup(<HeaderActionButtons />);
    expect(markup).toContain('aria-label="Workspace view"');
    expect(markup).toContain('aria-label="Preview"');
  });

  it('is shown once a chat has started', () => {
    chatStore.setKey('started', true);
    expect(renderToStaticMarkup(<HeaderActionButtons />)).toContain('aria-label="Chat"');
  });
});
