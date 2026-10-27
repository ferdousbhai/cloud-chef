import { useStore } from '@nanostores/react';
import type { ReactNode } from 'react';
import {
  builderModelUnavailableStore,
  builderNewModelsStore,
  dismissUnavailableBuilderModel,
  markBuilderModelsSeen,
} from '~/lib/stores/builder-model.client';
import type { BuilderModel } from '~/lib/workers-ai-model';

/** Beyond this the line stops being a line, so the rest is counted instead of named. */
const MAX_NAMED_MODELS = 2;

/**
 * Cloudflare adds models to Workers AI on its own schedule, an admin may link a provider key, and the
 * picker refreshes every session — so the only thing missing was being told. This says it once, quietly, next to the
 * picker that acts on it, and disappears for good as soon as the list has been seen. It also says when
 * the model this browser saved is no longer offered, so the switch to the default is never silent.
 */
export function NewModelsNotice() {
  const newModels = useStore(builderNewModelsStore);
  const unavailable = useStore(builderModelUnavailableStore);
  return (
    <>
      {unavailable ? (
        <Notice onDismiss={dismissUnavailableBuilderModel}>
          <span className="font-semibold text-content-warning">Model changed:</span> {unavailable.label} isn’t offered
          in this account any more, so new messages use {unavailable.replacementLabel}. The models are chosen in
          Settings, under Models, by the team&apos;s admins, or by you in Personal.
        </Notice>
      ) : null}
      {newModels.length > 0 ? (
        <Notice onDismiss={markBuilderModelsSeen}>
          <span className="font-semibold text-content-accent">New models:</span> {describeNewModels(newModels)} —
          available in the model picker.
        </Notice>
      ) : null}
    </>
  );
}

function Notice({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="mb-2 flex items-start gap-2 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2.5 py-1.5 text-xs leading-5 text-content-secondary"
    >
      <span aria-hidden="true" className="shrink-0 text-content-tertiary">
        {'//'}
      </span>
      <p className="min-w-0 grow">{children}</p>
      <button
        type="button"
        onClick={() => onDismiss()}
        className="shrink-0 rounded px-1 text-xs font-semibold text-content-tertiary transition-colors hover:text-content-primary"
      >
        Dismiss
      </button>
    </div>
  );
}

function describeNewModels(models: readonly BuilderModel[]): string {
  const named = models.slice(0, MAX_NAMED_MODELS).map(({ label }) => label);
  const remaining = models.length - named.length;
  return remaining > 0 ? `${named.join(', ')} and ${remaining} more` : named.join(' and ');
}
