import { indentLess } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { EditorSelection, type ChangeSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { type KeyBinding } from '@codemirror/view';

export const indentKeyBinding: KeyBinding = {
  key: 'Tab',
  run: indentMore,
  shift: indentLess,
};

function indentMore({ state, dispatch }: EditorView) {
  if (state.readOnly) {
    return false;
  }

  dispatch(
    state.update(
      changeBySelectedLine(state, (from, to, changes) => {
        changes.push({ from, to, insert: state.facet(indentUnit) });
      }),
      { userEvent: 'input.indent' },
    ),
  );

  return true;
}

function changeBySelectedLine(
  state: EditorState,
  cb: (from: number, to: number | undefined, changes: ChangeSpec[]) => void,
) {
  return state.changeByRange((range) => {
    const changes: ChangeSpec[] = [];

    const selectionStartLine = state.doc.lineAt(range.from);
    const isCursor = range.empty;
    const isSingleLineSelection = !isCursor && range.to <= selectionStartLine.to;

    if (isCursor) {
      cb(range.from, undefined, changes);
    } else if (isSingleLineSelection) {
      cb(range.from, range.to, changes);
    } else {
      let atLine = -1;

      for (let pos = range.from; pos <= range.to;) {
        const line = state.doc.lineAt(pos);

        if (line.number > atLine && range.to > line.from) {
          cb(line.from, undefined, changes);
          atLine = line.number;
        }

        pos = line.to + 1;
      }
    }

    const changeSet = state.changes(changes);

    return {
      changes,
      range: EditorSelection.range(changeSet.mapPos(range.anchor, 1), changeSet.mapPos(range.head, 1)),
    };
  });
}
