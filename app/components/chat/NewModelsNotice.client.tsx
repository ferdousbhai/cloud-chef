import { useStore } from '@nanostores/react';
import { builderNewModelsStore, markBuilderModelsSeen } from '~/lib/stores/builder-model.client';
import type { BuilderModel } from '~/lib/workers-ai-model';

/** Beyond this the line stops being a line, so the rest is counted instead of named. */
const MAX_NAMED_MODELS = 2;

/**
 * Cloudflare adds models to Workers AI on its own schedule, an admin may link a provider key, and the
 * picker refreshes every session — so the only thing missing was being told. This says it once, quietly, next to the
 * picker that acts on it, and disappears for good as soon as the list has been seen.
 */
export function NewModelsNotice() {
  const newModels = useStore(builderNewModelsStore);
  if (newModels.length === 0) {
    return null;
  }
  return (
    <div
      role="status"
      className="mb-2 flex items-start gap-2 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2.5 py-1.5 text-xs leading-5 text-content-secondary"
    >
      <span aria-hidden="true" className="shrink-0 text-content-tertiary">
        {'//'}
      </span>
      <p className="min-w-0 grow">
        <span className="font-semibold text-content-accent">New models:</span> {describeNewModels(newModels)} —
        available in the model picker.
      </p>
      <button
        type="button"
        onClick={() => markBuilderModelsSeen()}
        className="shrink-0 rounded px-1 text-[11px] font-semibold text-content-tertiary transition-colors hover:text-content-primary"
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
