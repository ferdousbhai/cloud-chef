import { Compartment, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { forwardRef, memo, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { EditorDocument } from 'ghostbuild-agent/types';
import { createScopedLogger, renderLogger } from 'ghostbuild-agent/utils/logger';
import type { Theme } from '~/lib/stores/theme';
import { classNames } from '~/utils/classNames';
import { BinaryContent } from './BinaryContent';
import { reconfigureTheme } from './cm-theme';
import { createEditorState } from './editor-config';
import { setEditorDocument } from './editor-document';
import { createEditorChangeBuffer } from './editor-change-buffer';
import type { OnChangeCallback, OnSaveCallback, OnScrollCallback, OnWheelCallback } from './editor-types';

export type { OnChangeCallback, OnSaveCallback, OnScrollCallback, OnWheelCallback } from './editor-types';

const logger = createScopedLogger('CodeMirrorEditor');
const CHANGE_DEBOUNCE_MS = 150;
type EditorStates = Map<string, EditorState>;

interface Props {
  theme: Theme;
  id: string;
  doc?: EditorDocument;
  scrollToDocAppend: boolean;
  editable?: boolean;
  autoFocusOnDocumentChange?: boolean;
  onChange?: OnChangeCallback;
  onScroll?: OnScrollCallback;
  onWheel?: OnWheelCallback;
  onSave?: OnSaveCallback;
  className?: string;
}

export type CodeMirrorEditorHandle = {
  flushPendingChange(): void;
};

export const CodeMirrorEditor = memo(
  forwardRef<CodeMirrorEditorHandle, Props>(function CodeMirrorEditor(
    {
      id,
      doc,
      autoFocusOnDocumentChange = false,
      editable = true,
      onScroll,
      onChange,
      onWheel,
      onSave,
      scrollToDocAppend,
      theme,
      className = '',
    },
    ref,
  ) {
    renderLogger.trace('CodeMirrorEditor');
    const [languageCompartment] = useState(() => new Compartment());
    const containerRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const themeRef = useRef<Theme | null>(null);
    const docRef = useRef<EditorDocument | undefined>(undefined);
    const projectIdRef = useRef(id);
    const editorStatesRef = useRef<EditorStates>(new Map());
    const onScrollRef = useRef(onScroll);
    const onWheelRef = useRef(onWheel);
    const onChangeRef = useRef(onChange);
    const onSaveRef = useRef(onSave);
    const flushPendingChangeRef = useRef<() => void>(() => undefined);
    const onSaveWithFlushRef = useRef<OnSaveCallback>(() => {
      flushPendingChangeRef.current();
      onSaveRef.current?.();
    });

    useImperativeHandle(ref, () => ({ flushPendingChange: () => flushPendingChangeRef.current() }), []);

    useLayoutEffect(() => {
      const previousDocument = docRef.current;
      const crossesDocumentBoundary =
        previousDocument !== undefined &&
        (projectIdRef.current !== id ||
          previousDocument.filePath !== doc?.filePath ||
          previousDocument.value !== doc?.value ||
          previousDocument.isBinary !== doc?.isBinary);
      if (crossesDocumentBoundary) {
        flushPendingChangeRef.current();
      }
      projectIdRef.current = id;
      docRef.current = doc;
    }, [doc, id]);

    useEffect(() => {
      onScrollRef.current = onScroll;
      onWheelRef.current = onWheel;
      onChangeRef.current = onChange;
      onSaveRef.current = onSave;
      themeRef.current = theme;
    });

    useEffect(() => {
      const parent = containerRef.current;
      if (!parent) {
        return undefined;
      }
      const changeBuffer = createEditorChangeBuffer(CHANGE_DEBOUNCE_MS);
      flushPendingChangeRef.current = changeBuffer.flush;
      const view = new EditorView({
        parent,
        dispatchTransactions(transactions) {
          const previousSelection = view.state.selection;
          view.update(transactions);
          const nextSelection = view.state.selection;
          const selectionChanged = nextSelection !== previousSelection && !nextSelection.eq(previousSelection);
          if (docRef.current && (transactions.some((transaction) => transaction.docChanged) || selectionChanged)) {
            changeBuffer.queue({
              callback: onChangeRef.current,
              update: {
                selection: nextSelection,
                content: view.state.doc.toString(),
                filePath: docRef.current.filePath,
                projectId: projectIdRef.current,
              },
            });
            editorStatesRef.current.set(docRef.current.filePath, view.state);
          }
        },
      });
      viewRef.current = view;
      return () => {
        changeBuffer.flush();
        flushPendingChangeRef.current = () => undefined;
        view.destroy();
        viewRef.current = null;
      };
    }, []);

    useEffect(() => {
      viewRef.current?.dispatch({ effects: [reconfigureTheme(theme)] });
    }, [theme]);

    useEffect(() => {
      editorStatesRef.current = new Map();
    }, [id]);

    useEffect(() => {
      const view = viewRef.current;
      const currentTheme = themeRef.current;
      const currentDocument = docRef.current;
      if (!view || !currentTheme) {
        return;
      }
      const callbacks = { onScroll: onScrollRef, onWheel: onWheelRef, onSave: onSaveWithFlushRef };
      if (!currentDocument) {
        view.setState(createEditorState('', currentTheme, callbacks, [languageCompartment.of([])]));
        view.scrollDOM.scrollTo(0, 0);
        return;
      }
      if (currentDocument.isBinary) {
        return;
      }
      if (!currentDocument.filePath) {
        logger.warn('File path should not be empty');
      }

      const editorStates = editorStatesRef.current;
      let state = editorStates.get(currentDocument.filePath);
      if (!state) {
        state = createEditorState(currentDocument.value, currentTheme, callbacks, [languageCompartment.of([])]);
        editorStates.set(currentDocument.filePath, state);
      }
      const simpleAppend = currentDocument.value.startsWith(view.state.doc.toString());
      const isFileChange = currentDocument.value.length < 50 || !simpleAppend;
      if (isFileChange) {
        view.setState(state);
        // Cached states keep the theme they were created with, so re-apply the current one.
        view.dispatch({ effects: [reconfigureTheme(currentTheme)] });
      }
      setEditorDocument({
        view,
        editable,
        languageCompartment,
        autoFocus: autoFocusOnDocumentChange,
        document: currentDocument,
        isCurrentDocument: () => docRef.current?.filePath === currentDocument.filePath && viewRef.current === view,
        isFileChange,
        scrollToBottom: scrollToDocAppend && simpleAppend,
      });
    }, [
      doc?.isBinary,
      doc?.value,
      doc?.filePath,
      editable,
      autoFocusOnDocumentChange,
      scrollToDocAppend,
      languageCompartment,
    ]);

    return (
      <div className={classNames('relative h-full', className)}>
        {doc?.isBinary && <BinaryContent />}
        <div className="h-full overflow-hidden" ref={containerRef} />
      </div>
    );
  }),
);

CodeMirrorEditor.displayName = 'CodeMirrorEditor';
