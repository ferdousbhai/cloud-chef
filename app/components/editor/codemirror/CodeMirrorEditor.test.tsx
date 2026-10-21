// @vitest-environment jsdom

import { undo, undoDepth } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorDocument } from 'cloudchef-agent/types';
import { getAbsolutePath, type AbsolutePath } from 'cloudchef-agent/utils/workDir';
import { CodeMirrorEditor } from './CodeMirrorEditor';

const fileA = getAbsolutePath('/home/project/a.ts');
const fileB = getAbsolutePath('/home/project/b.ts');
const contentA = `export const a = 'the first file shown in the editor, long enough to be an append';\n`;
const contentB = `export const b = 'the second file shown in the editor, long enough to be an append';\n`;
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  // jsdom lays nothing out, so it has no element scrolling or text geometry for the view to measure.
  Element.prototype.scrollTo = () => undefined;
  Range.prototype.getClientRects = () => document.createElement('span').getClientRects();
  Range.prototype.getBoundingClientRect = () => document.createElement('span').getBoundingClientRect();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function textDocument(filePath: AbsolutePath, value: string): EditorDocument {
  return { filePath, value, isBinary: false };
}

async function renderEditor(props: { doc?: EditorDocument; editable?: boolean; onSave?: () => void }) {
  await act(async () => {
    root?.render(<CodeMirrorEditor id="project-a" theme="light" scrollToDocAppend={false} {...props} />);
  });
}

function editorView(): EditorView {
  const editor = container.querySelector<HTMLElement>('.cm-editor');
  const view = editor && EditorView.findFromDOM(editor);
  if (!view) {
    throw new Error('The editor view did not mount.');
  }
  return view;
}

function pressCtrlS(view: EditorView) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
  );
}

describe('CodeMirrorEditor', () => {
  it('gives the first file shown its configured state', async () => {
    const onSave = vi.fn();
    await renderEditor({ doc: textDocument(fileA, contentA), editable: false, onSave });
    const view = editorView();

    expect(view.state.doc.toString()).toBe(contentA);
    expect(view.state.readOnly).toBe(true);
    expect(container.querySelector('.cm-lineNumbers')).not.toBeNull();

    await renderEditor({ doc: textDocument(fileA, contentA), editable: true, onSave });
    pressCtrlS(view);

    expect(onSave).toHaveBeenCalledOnce();
  });

  it('cannot undo a file that arrived after the editor mounted back to an empty buffer', async () => {
    await renderEditor({});
    await renderEditor({ doc: textDocument(fileA, contentA) });
    const view = editorView();

    expect(undoDepth(view.state)).toBe(0);
    undo(view);
    expect(view.state.doc.toString()).toBe(contentA);
  });

  it('installs the next file as a file switch even when its text extends the previous one', async () => {
    await renderEditor({ doc: textDocument(fileA, contentA) });
    await renderEditor({ doc: textDocument(fileB, `${contentA}${contentB}`) });
    const view = editorView();

    expect(undoDepth(view.state)).toBe(0);
    undo(view);
    expect(view.state.doc.toString()).toBe(`${contentA}${contentB}`);
  });

  it('streams an append to the same file into its current state and history', async () => {
    await renderEditor({ doc: textDocument(fileA, contentA) });
    await renderEditor({ doc: textDocument(fileA, `${contentA}${contentB}`) });
    const view = editorView();

    expect(view.state.doc.toString()).toBe(`${contentA}${contentB}`);
    expect(undoDepth(view.state)).toBe(1);
  });
});
