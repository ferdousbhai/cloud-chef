// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { getAbsolutePath } from 'cloudchef-agent/utils/workDir';
import { FileBreadcrumb } from './FileBreadcrumb';

it('opens folders and selects a file using only the keyboard', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const filePath = getAbsolutePath('src/routes/index.tsx');
  const select = vi.fn();
  const key = async (element: Element, value: string) => {
    await act(async () => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  try {
    await act(async () =>
      root.render(
        <FileBreadcrumb
          pathSegments={filePath.split('/')}
          files={{ [filePath]: { type: 'file', content: '', isBinary: false } }}
          onFileSelect={select}
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Browse routes"]')!;
    trigger.focus();
    await key(trigger, 'ArrowDown');
    const folder = document.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(document.activeElement).toBe(folder);
    await key(folder, 'Enter');
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    await key(folder, 'ArrowDown');
    const file = document.querySelectorAll('[role="menuitem"]')[1];
    expect(document.activeElement).toBe(file);
    await key(file, 'Enter');
    expect(select).toHaveBeenCalledWith(filePath);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
