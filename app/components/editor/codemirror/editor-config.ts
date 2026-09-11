import { acceptCompletion, autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, foldGutter, indentOnInput, indentUnit } from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  scrollPastEnd,
  showTooltip,
  tooltips,
  type Tooltip,
} from '@codemirror/view';
import type { MutableRefObject } from 'react';
import type { Theme } from '~/lib/stores/theme';
import { debounce } from '~/utils/debounce';
import { getTheme } from './cm-theme';
import { indentKeyBinding } from './indent';
import type { EditorSettings, OnSaveCallback, OnScrollCallback, OnWheelCallback } from './editor-types';

const SCROLL_DEBOUNCE_MS = 100;
const readOnlyTooltipEffect = StateEffect.define<boolean>();
export const editableEffect = StateEffect.define<boolean>();

const editableTooltipField = StateField.define<readonly Tooltip[]>({
  create: () => [],
  update(_tooltips, transaction) {
    if (!transaction.state.readOnly) {
      return [];
    }
    for (const effect of transaction.effects) {
      if (effect.is(readOnlyTooltipEffect) && effect.value) {
        return getReadOnlyTooltip(transaction.state);
      }
    }
    return [];
  },
  provide: (field) => showTooltip.computeN([field], (state) => state.field(field)),
});

const editableField = StateField.define<boolean>({
  create: () => true,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(editableEffect)) {
        return effect.value;
      }
    }
    return value;
  },
});

interface EditorCallbackRefs {
  onScroll: MutableRefObject<OnScrollCallback | undefined>;
  onWheel: MutableRefObject<OnWheelCallback | undefined>;
  onSave: MutableRefObject<OnSaveCallback | undefined>;
}

export function createEditorState(
  content: string,
  theme: Theme,
  settings: EditorSettings,
  callbacks: EditorCallbackRefs,
  extensions: Extension[],
): EditorState {
  return EditorState.create({
    doc: content,
    extensions: [
      EditorView.domEventHandlers({
        scroll: debounce((event, view) => {
          if (event.target === view.scrollDOM) {
            callbacks.onScroll.current?.({ left: view.scrollDOM.scrollLeft, top: view.scrollDOM.scrollTop });
          }
        }, SCROLL_DEBOUNCE_MS),
        wheel: () => callbacks.onWheel.current?.(),
        keydown: (event, view) => {
          if (!view.state.readOnly) {
            return false;
          }
          view.dispatch({ effects: [readOnlyTooltipEffect.of(event.key !== 'Escape')] });
          // Swallow only the keys that would edit the document. A blanket `true` also calls
          // preventDefault() and stops the rest of the handler chain, which took copy, find and
          // caret movement with it for the whole streaming window. The edits themselves are
          // already impossible: the view ignores DOM-originated changes while read-only, rejects
          // paste and drop, and every editing command in the keymap checks `state.readOnly`.
          return (
            (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) ||
            event.key === 'Backspace' ||
            event.key === 'Delete' ||
            event.key === 'Enter'
          );
        },
      }),
      getTheme(theme),
      history(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        { key: 'Tab', run: acceptCompletion },
        {
          key: 'Mod-s',
          preventDefault: true,
          run: (view) => {
            // Saving publishes a preview, which the UI disables while the agent streams. Read-only
            // is how that state reaches the editor, so the binding stays inert rather than firing.
            if (view.state.readOnly) {
              return true;
            }
            callbacks.onSave.current?.();
            return true;
          },
        },
        indentKeyBinding,
      ]),
      indentUnit.of('\t'),
      autocompletion({ closeOnBlur: false }),
      tooltips({
        position: 'absolute',
        parent: document.body,
        tooltipSpace: (view) => {
          const rect = view.dom.getBoundingClientRect();
          return { top: rect.top - 50, left: rect.left, bottom: rect.bottom, right: rect.right + 10 };
        },
      }),
      closeBrackets(),
      lineNumbers(),
      scrollPastEnd(),
      dropCursor(),
      drawSelection(),
      bracketMatching(),
      EditorState.tabSize.of(settings.tabSize ?? 2),
      indentOnInput(),
      editableTooltipField,
      editableField,
      EditorState.readOnly.from(editableField, (editable) => !editable),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      foldGutter({}),
      ...extensions,
    ],
  });
}

function getReadOnlyTooltip(state: EditorState): Tooltip[] {
  if (!state.readOnly) {
    return [];
  }
  return state.selection.ranges
    .filter((range) => range.empty)
    .map((range) => ({
      pos: range.head,
      above: true,
      strictSide: true,
      arrow: true,
      create: () => {
        const element = document.createElement('div');
        element.className = 'cm-readonly-tooltip';
        element.textContent = 'Cannot edit file while AI response is being generated';
        return { dom: element };
      },
    }));
}
