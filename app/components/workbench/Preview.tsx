import type { BuilderLinkedSite } from '~/agents/conversation-agent';

export const PREVIEW_SANDBOX = 'allow-forms allow-modals allow-popups allow-same-origin allow-scripts';

/** The project's site beside the chat: the preview this conversation made last, else the live site. */
export function Preview({ site, reloadKey }: { site: BuilderLinkedSite | null; reloadKey: number }) {
  if (!site) {
    return (
      <div className="flex size-full flex-col overflow-y-auto bg-bolt-elements-background-depth-1 p-6 text-center">
        <div className="m-auto w-full max-w-sm shrink-0 wrap-break-word">
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
        <span className="shrink-0 whitespace-nowrap font-medium text-content-secondary">{label}</span>
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
            <div className="m-auto w-full max-w-sm shrink-0 wrap-break-word">
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
