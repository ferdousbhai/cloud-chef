// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { Modal } from './Modal';

function Example() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open dialog</button>
      {open && (
        <Modal title="Example" onClose={() => setOpen(false)}>
          Dialog content
        </Modal>
      )}
    </>
  );
}

it('returns keyboard focus to the opener when a controlled dialog closes', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Example />));
    const opener = container.querySelector('button')!;
    opener.focus();
    await act(async () => opener.click());
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!;
    expect(close).not.toBeNull();
    await act(async () => close.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(opener);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
