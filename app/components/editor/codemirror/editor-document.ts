import type { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { EditorDocument } from 'ghostbuild-agent/types';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { editableEffect } from './editor-config';
import { getLanguage } from './languages';

type TextEditorDocument = EditorDocument & { value: string };
const logger = createScopedLogger('EditorDocument');

interface SetEditorDocumentOptions {
  view: EditorView;
  editable: boolean;
  languageCompartment: Compartment;
  autoFocus: boolean;
  document: TextEditorDocument;
  isCurrentDocument: () => boolean;
  isFileChange: boolean;
  scrollToBottom: boolean;
}

export function setEditorDocument({
  view,
  editable,
  languageCompartment,
  autoFocus,
  document,
  isCurrentDocument,
  isFileChange,
  scrollToBottom,
}: SetEditorDocumentOptions): void {
  if (document.value !== view.state.doc.toString()) {
    view.dispatch({
      selection: { anchor: 0 },
      changes: { from: 0, to: view.state.doc.length, insert: document.value },
    });
  }
  view.dispatch({ effects: [editableEffect.of(editable && !document.isBinary)] });
  if (isFileChange) {
    view.dispatch({ effects: languageCompartment.reconfigure([]) });
    restoreDocumentPosition(view, document, autoFocus && editable, isCurrentDocument);
  }
  if (scrollToBottom) {
    scrollNearDocumentEnd(view, isCurrentDocument);
  }

  void getLanguage(document.filePath)
    .then((languageSupport) => {
      if (!isCurrentDocument()) {
        return;
      }
      view.dispatch({
        effects: languageCompartment.reconfigure(languageSupport ? [languageSupport] : []),
      });
    })
    .catch((error) => {
      logger.warn('Failed to load editor language support', { error, filePath: document.filePath });
    });
}

function restoreDocumentPosition(
  view: EditorView,
  document: TextEditorDocument,
  autoFocus: boolean,
  isCurrentDocument: () => boolean,
): void {
  requestAnimationFrame(() => {
    if (!isCurrentDocument()) {
      return;
    }
    const newLeft = document.scroll?.left ?? 0;
    const newTop = document.scroll?.top ?? 0;
    if (autoFocus) {
      // Focusing before the scroll is safe: EditorView.focus() prevents the browser's scroll-into-view,
      // and deferring it to a scroll event leaks the listener when scrollTo is clamped to a no-op.
      view.focus();
    }
    view.scrollDOM.scrollTo(newLeft, newTop);
  });
}

function scrollNearDocumentEnd(view: EditorView, isCurrentDocument: () => boolean): void {
  requestAnimationFrame(() => {
    if (!isCurrentDocument()) {
      return;
    }
    const { scrollDOM } = view;
    const pagesOffscreen =
      (scrollDOM.scrollHeight - scrollDOM.scrollTop - scrollDOM.offsetHeight) / scrollDOM.offsetHeight;
    if (pagesOffscreen > 0.9) {
      const desiredPagesOffscreen = 0.5;
      scrollDOM.scrollTo(0, scrollDOM.scrollHeight - scrollDOM.offsetHeight * (desiredPagesOffscreen + 1));
    }
  });
}
