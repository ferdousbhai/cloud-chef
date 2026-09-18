import { Spinner } from '@ui/Spinner';

export function Loading(props: { message?: string }) {
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto p-6 text-center"
      role="status"
      aria-live="polite"
    >
      <div className="m-auto flex shrink-0 flex-col items-center gap-4">
        <div className="app-loading-mark" aria-hidden>
          <Spinner />
        </div>
        <p className="text-sm text-content-secondary">{props.message ?? 'Loading…'}</p>
      </div>
    </div>
  );
}
