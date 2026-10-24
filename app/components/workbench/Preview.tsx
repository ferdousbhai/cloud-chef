import { Button } from '@ui/Button';
import type { AppSitePresentation } from '~/lib/common/app-site';
import { publicationStageLabel, type BuilderPublicationState } from '~/agents/builder-publication-progress';

export const PREVIEW_SANDBOX = 'allow-forms allow-modals allow-popups allow-same-origin allow-scripts';

/** The app's one site, as production serves it, framed beside the chat. */
export function Preview({
  presentation,
  publication,
  reloadKey,
  requesting,
  onPublish,
  linkedRepository = null,
}: {
  presentation: AppSitePresentation;
  publication: BuilderPublicationState | null;
  reloadKey: number;
  requesting: boolean;
  onPublish: () => void;
  /** A GitHub project's repository: its previews come from its own pipeline, not from CloudChef. */
  linkedRepository?: string | null;
}) {
  const { url, revision, status, error } = presentation;

  if (linkedRepository) {
    return <LinkedPreviewNotice repository={linkedRepository} />;
  }

  return (
    <div className="flex size-full min-h-0 flex-col bg-bolt-elements-background-depth-1">
      {url && status === 'failed' && (
        <div
          className="flex items-center gap-3 border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-content-error"
          role="status"
        >
          <span className="min-w-0 flex-1 break-words">
            {error ?? 'Publishing the latest changes failed.'} The site still shows the last version that published.
          </span>
          <Button size="xs" variant="neutral" disabled={requesting} onClick={onPublish}>
            Retry
          </Button>
        </div>
      )}

      {url && (
        <div className="flex items-center gap-2 border-b border-bolt-elements-borderColor px-3 py-1 text-xs text-content-tertiary">
          <span className="font-medium text-content-secondary">Your app</span>
          <a className="min-w-0 truncate underline" href={url} target="_blank" rel="noreferrer">
            {new URL(url).host}
          </a>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {url ? (
          <iframe
            key={`${url}:${revision}:${reloadKey}`}
            className="size-full border-0 bg-white"
            src={url}
            title="Your app"
            sandbox={PREVIEW_SANDBOX}
            referrerPolicy="no-referrer"
          />
        ) : (
          <PreviewEmpty
            status={status}
            error={error}
            publication={publication}
            onPublish={onPublish}
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
  onPublish,
  disabled,
}: {
  status: AppSitePresentation['status'];
  error: string | null;
  publication: BuilderPublicationState | null;
  onPublish: () => void;
  disabled: boolean;
}) {
  const publishing = status === 'publishing';
  const title = status === 'failed' ? 'Publishing failed' : publishing ? 'Publishing your app…' : 'Not published yet';
  const message =
    status === 'failed'
      ? error
      : publishing
        ? publicationStageLabel(publication)
        : 'Your app appears here once it is published.';
  return (
    <div className="flex size-full flex-col overflow-y-auto p-6 text-center">
      <div className="m-auto w-full max-w-sm shrink-0 break-words">
        <p className="font-medium text-content-primary">{title}</p>
        {message && (
          <p className="mt-2 text-sm text-content-secondary" aria-live="polite">
            {message}
          </p>
        )}
        {!publishing && (
          <Button className="mt-4" size="sm" disabled={disabled} onClick={onPublish}>
            {status === 'failed' ? 'Retry' : 'Publish'}
          </Button>
        )}
      </div>
    </div>
  );
}

/** A GitHub project's previews are built by its repository's pipeline from the branch the agent publishes. */
function LinkedPreviewNotice({ repository }: { repository: string }) {
  return (
    <div className="flex size-full flex-col overflow-y-auto bg-bolt-elements-background-depth-1 p-6 text-center">
      <div className="m-auto w-full max-w-sm shrink-0 break-words">
        <p className="font-medium text-content-primary">Previews come from your branch&apos;s pipeline</p>
        <p className="mt-2 text-sm text-content-secondary">
          Ask the agent to publish a preview: it sends your changes to a branch of {repository} and shares the link its
          pipeline builds.
        </p>
      </div>
    </div>
  );
}
