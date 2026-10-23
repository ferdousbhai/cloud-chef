import type { ReactNode } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

export function ConfirmationDialog({
  onClose,
  onConfirm,
  confirmText,
  dialogTitle,
  dialogBody,
}: {
  onClose: () => void;
  onConfirm: () => void;
  confirmText: string;
  dialogTitle: ReactNode;
  dialogBody: ReactNode;
}) {
  return (
    <Modal onClose={onClose} title={dialogTitle}>
      <div className="text-content-secondary text-sm">{dialogBody}</div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="neutral" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          {confirmText}
        </Button>
      </div>
    </Modal>
  );
}
