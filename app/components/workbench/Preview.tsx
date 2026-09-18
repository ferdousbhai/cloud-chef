import { useEffect } from 'react';
import { Button } from '@ui/Button';
import { captureProductEvent } from '~/lib/telemetry.client';
import type { PreviewPresentation } from '~/lib/common/preview-presentation';
import { publicationStageLabel, type BuilderPublicationState } from '~/agents/builder-publication-progress';

export const PREVIEW_SANDBOX = 'allow-forms allow-modals allow-popups allow-same-origin allow-scripts';

export function Preview({
  presentation,
  publication,
  reloadKey,
  requesting,
  onRequest,
  error,
}: {
  presentation: PreviewPresentation;
  publication: BuilderPublicationState | null;
  reloadKey: number;
  requesting: boolean;
  onRequest: () => void;
  error: string | null;
}) {
  const { preview, previewUrl, status } = presentation;

  useEffect(() => {
    if (status === 'ready' && preview) {
      void captureProductEvent('preview_ready', {
        outcome: 'success',
        workspaceRevision: preview.workspaceRevision,
      });
    }
  }, [preview, status]);

  return (
    <div className="flex size-full min-h-0 flex-col bg-bolt-elements-background-depth-1">
      {previewUrl && preview && status === 'failed' && (
        <div
          className="flex items-center gap-3 border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-content-error"
          role="status"
        >
          <span className="min-w-0 flex-1 break-words">{error ?? 'The latest preview failed.'}</span>
          <Button size="xs" variant="neutral" disabled={requesting} onClick={onRequest}>
            Retry
          </Button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {previewUrl && preview ? (
          <iframe
            key={`${preview.id}:${reloadKey}`}
            className="size-full border-0 bg-white"
            src={previewUrl}
            title={`Workers preview for durable revision ${preview.workspaceRevision}`}
            sandbox={PREVIEW_SANDBOX}
            referrerPolicy="no-referrer"
          />
        ) : (
          <PreviewEmpty
            status={status}
            error={error}
            publication={publication}
            onRequest={onRequest}
            disabled={requesting}
          />
        )}
      </div>
    </div>
  );
}

function PreviewEmpty({
  status,
  error,
  publication,
  onRequest,
  disabled,
}: {
  status: string;
  error: string | null;
  publication: BuilderPublicationState | null;
  onRequest: () => void;
  disabled: boolean;
}) {
  const updating = status === 'queued' || status === 'building';
  const title = status === 'failed' ? 'Preview failed' : updating ? 'Building preview…' : 'No preview yet';
  const stage = updating && publication?.lane === 'preview' ? publicationStageLabel(publication) : null;
  const message = status === 'failed' ? error : updating ? stage : 'Build the current revision.';
  return (
    <div className="flex size-full flex-col overflow-y-auto p-6 text-center">
      <div className="m-auto w-full max-w-sm shrink-0 break-words">
        <p className="font-medium text-content-primary">{title}</p>
        {message && (
          <p className="mt-2 text-sm text-content-secondary" aria-live="polite">
            {message}
          </p>
        )}
        {!updating && (
          <Button className="mt-4" size="sm" disabled={disabled} onClick={onRequest}>
            {status === 'failed' ? 'Retry' : 'Build preview'}
          </Button>
        )}
      </div>
    </div>
  );
}
