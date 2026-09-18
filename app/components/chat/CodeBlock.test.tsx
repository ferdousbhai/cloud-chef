// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { CodeBlock } from './CodeBlock';

it('copies the full source and explains clipboard failures', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const reportError = vi.spyOn(toast, 'error');
  const writeText = vi.fn().mockRejectedValueOnce(new Error('permission denied')).mockResolvedValueOnce(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CodeBlock code={'const answer = 42;\n'} />));
    const button = container.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('Copy code');
    await act(async () => button.click());
    expect(reportError).toHaveBeenCalledOnce();
    expect(button.getAttribute('aria-label')).toBe('Copy code');
    await act(async () => button.click());
    expect(writeText).toHaveBeenLastCalledWith('const answer = 42;\n');
    expect(button.getAttribute('aria-label')).toBe('Copied');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    reportError.mockRestore();
  }
});
