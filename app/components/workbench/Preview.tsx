import { Button } from '@ui/Button';
import type { AppSitePresentation } from '~/lib/common/app-site';
import { publicationStageLabel, type BuilderPublicationState } from '~/agents/builder-publication-progress';
import type { BuilderLinkedSite } from '~/agents/conversation-agent';

export const PREVIEW_SANDBOX = 'allow-forms allow-modals allow-popups allow-same-origin allow-scripts';

/** The app's one site, as production serves it, framed beside the chat. */
export function Preview({
  presentation,
  publication,
  reloadKey,
  requesting,
  onPublish,
  linkedSite,
}: {
  presentation: AppSitePresentation;
  publication: BuilderPublicationState | null;
  reloadKey: number;
  requesting: boolean;
  onPublish: () => void;
  /** A team or uploaded project's site (null before it has one); absent for a CloudChef app. */
  linkedSite?: BuilderLinkedSite | null;
}) {
  const { url, revision, status, error } = presentation;

  if (linkedSite !== undefined) {
    return <LinkedSitePreview site={linkedSite} reloadKey={reloadKey} />;
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
            Try again
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
            {status === 'failed' ? 'Try again' : 'Publish'}
          </Button>
        )}
      </div>
    </div>
  );
}

/** A team or uploaded project's site beside the chat: the preview this conversation made last, else the live site. */
function LinkedSitePreview({ site, reloadKey }: { site: BuilderLinkedSite | null; reloadKey: number }) {
  if (!site) {
    return (
      <div className="flex size-full flex-col overflow-y-auto bg-bolt-elements-background-depth-1 p-6 text-center">
        <div className="m-auto w-full max-w-sm shrink-0 break-words">
          <p className="font-medium text-content-primary">Not published yet</p>
          <p className="mt-2 text-sm text-content-secondary">The site shows here once it is published.</p>
        </div>
      </div>
    );
  }
  const label = site.kind === 'preview' ? 'Preview of your changes' : 'Live site';
  return (
    <div className="flex size-full min-h-0 flex-col bg-bolt-elements-background-depth-1">
      <div className="flex items-center gap-2 border-b border-bolt-elements-borderColor px-3 py-1 text-xs text-content-tertiary">
        <span className="font-medium text-content-secondary">{label}</span>
        <a className="min-w-0 truncate underline" href={site.url} target="_blank" rel="noreferrer">
          {new URL(site.url).host}
        </a>
        <a className="ml-auto shrink-0 underline" href={site.url} target="_blank" rel="noreferrer">
          Open in new tab
        </a>
      </div>
      <div className="relative min-h-0 flex-1">
        {site.frameable === false ? (
          <div className="flex size-full flex-col overflow-y-auto p-6 text-center">
            <div className="m-auto w-full max-w-sm shrink-0 break-words">
              <p className="font-medium text-content-primary">This site can&apos;t be shown here</p>
              <p className="mt-2 text-sm text-content-secondary">
                It asks browsers not to show it inside other pages. Open it in a new tab instead.
              </p>
            </div>
          </div>
        ) : (
          <iframe
            key={`${site.url}:${reloadKey}`}
            className="size-full border-0 bg-white"
            src={site.url}
            title={label}
            sandbox={PREVIEW_SANDBOX}
            referrerPolicy="no-referrer"
          />
        )}
      </div>
    </div>
  );
}
