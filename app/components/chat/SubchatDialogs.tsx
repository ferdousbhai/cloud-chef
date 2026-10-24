import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { TextInput } from '@ui/TextInput';

interface SubchatDialogsProps {
  createOpen: boolean;
  createDisabled: boolean;
  createPending: boolean;
  renameOpen: boolean;
  renameValue: string;
  renamePending: boolean;
  renameDisabled: boolean;
  closeCreate: () => void;
  closeRename: () => void;
  confirmCreate: () => Promise<void>;
  confirmRename: () => Promise<void>;
  setRenameValue: (value: string) => void;
}

export function SubchatDialogs(props: SubchatDialogsProps) {
  return (
    <>
      {props.createOpen && (
        <Modal onClose={props.closeCreate} title="Create new chat">
          <div className="flex flex-col gap-2">
            <p className="text-content-primary text-sm">
              A new chat starts with fresh context and keeps working on the same project: its files, history and live
              app. Earlier chats stay to read.
            </p>
            <DialogActions
              cancel={props.closeCreate}
              confirm={props.confirmCreate}
              confirmLabel="New chat"
              disabled={props.createDisabled}
              pending={props.createPending}
            />
          </div>
        </Modal>
      )}
      {props.renameOpen && (
        <Modal onClose={props.closeRename} title="Rename chat">
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void props.confirmRename();
            }}
          >
            <TextInput
              autoFocus
              aria-label="Chat title"
              maxLength={200}
              value={props.renameValue}
              onChange={(event) => props.setRenameValue(event.target.value)}
            />
            <DialogActions
              cancel={props.closeRename}
              confirm={props.confirmRename}
              confirmLabel="Save title"
              disabled={props.renameDisabled}
              pending={props.renamePending}
            />
          </form>
        </Modal>
      )}
    </>
  );
}

function DialogActions({
  cancel,
  confirm,
  confirmLabel,
  disabled = false,
  pending = false,
}: {
  cancel: () => void;
  confirm: () => void | Promise<void>;
  confirmLabel: string;
  disabled?: boolean;
  pending?: boolean;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="neutral" onClick={cancel} disabled={pending}>
        Cancel
      </Button>
      <Button variant="primary" onClick={confirm} disabled={disabled} loading={pending} aria-busy={pending}>
        {confirmLabel}
      </Button>
    </div>
  );
}
