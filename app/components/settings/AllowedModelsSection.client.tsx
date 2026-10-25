import { ChevronRightIcon } from '@radix-ui/react-icons';
import { useState } from 'react';
import { Button } from '~/components/ui/primitives/Button';
import { classNames } from '~/utils/classNames';
import {
  effectiveDefaultModelId,
  GATEWAY_PROVIDER_SLUGS,
  GATEWAY_PROVIDERS,
  gatewayModelProvider,
  type BuilderModel,
  type GatewayProviderSlug,
} from '~/lib/workers-ai-model';
import { StatusBadge } from './SettingsLayout';

type Group = { provider: GatewayProviderSlug | 'workers'; label: string; models: BuilderModel[] };

/** The models being chosen, before they are saved: every compatible one, or only those in `ids`. */
type Draft = { mode: 'all' } | { mode: 'chosen'; ids: ReadonlySet<string> };

/** A group this long starts folded, so one provider's long list doesn't bury the others. */
const MAX_OPEN_GROUP_MODELS = 20;

/**
 * Which models the account's model picker offers, as its admin chooses them: every compatible model
 * (including ones added later), or only the ones ticked here, grouped by provider. The default model
 * is always allowed, so its box stays ticked; another default is chosen above first. Members see the
 * same list, without changing it.
 */
export function AllowedModelsSection({
  allowedModelIds,
  defaultModelId,
  compatibleModels,
  compatibleError,
  canManage,
  busy,
  onSave,
  onRetry,
}: {
  allowedModelIds: string[] | null;
  defaultModelId: string | null;
  /** Every model the account could offer; null while loading. */
  compatibleModels: BuilderModel[] | null;
  compatibleError: string | null;
  canManage: boolean;
  busy: boolean;
  onSave: (modelIds: string[] | null) => Promise<boolean>;
  onRetry: () => void;
}) {
  const saved: Draft = allowedModelIds === null ? { mode: 'all' } : { mode: 'chosen', ids: new Set(allowedModelIds) };
  const [draft, setDraft] = useState<Draft | null>(null);
  const current = draft ?? saved;
  const defaultId = effectiveDefaultModelId(defaultModelId);
  const allIds = (compatibleModels ?? []).map(({ id }) => id);
  const isAllowed = (id: string) => current.mode === 'all' || current.ids.has(id);
  // Until the account's models are listed, a change would be made against an empty list and save only the default.
  const disabled = !canManage || busy || compatibleModels === null;

  /** Ticks or unticks `ids`; the default always stays ticked, and the first change chooses models one by one. */
  const change = (ids: readonly string[], allowed: boolean) => {
    const next = new Set(current.mode === 'all' ? allIds : current.ids);
    for (const id of ids) {
      if (allowed) {
        next.add(id);
      } else if (id !== defaultId) {
        next.delete(id);
      }
    }
    setDraft({ mode: 'chosen', ids: next });
  };

  const dirty = draft !== null && !sameDraft(draft, saved);
  const save = async () => {
    const modelIds = current.mode === 'all' ? null : [...new Set([defaultId, ...current.ids])];
    if (await onSave(modelIds)) {
      setDraft(null);
    }
  };

  const groups = groupByProvider(compatibleModels ?? []);
  const listed = new Set<string>(allIds);
  const unavailable = current.mode === 'chosen' ? [...current.ids].filter((id) => !listed.has(id)) : [];

  return (
    <div className="mt-6">
      <h3 className="text-sm font-medium text-content-primary">Models in the picker</h3>
      <p className="mt-1 text-xs text-content-tertiary">
        {canManage
          ? 'Leave out models people shouldn’t pick, such as ones that use up credits quickly or don’t do well enough at building.'
          : 'Chosen by this team’s admins. You can pick any of the allowed models in the builder.'}
      </p>
      <fieldset className="mt-3 grid gap-1.5">
        <legend className="sr-only">Which models the picker offers</legend>
        <label className="flex min-w-0 items-start gap-2 text-sm text-content-primary">
          <input
            type="radio"
            name="allowed-models-mode"
            className="mt-1"
            disabled={disabled}
            checked={current.mode === 'all'}
            onChange={() => setDraft({ mode: 'all' })}
          />
          <span>Every compatible model, including ones added later</span>
        </label>
        <label className="flex min-w-0 items-start gap-2 text-sm text-content-primary">
          <input
            type="radio"
            name="allowed-models-mode"
            className="mt-1"
            disabled={disabled}
            checked={current.mode === 'chosen'}
            onChange={() => change([], true)}
          />
          <span>
            Only the models ticked below
            <span className="block text-xs text-content-tertiary">
              Models added later stay off until {canManage ? 'you allow' : 'an admin allows'} them.
            </span>
          </span>
        </label>
      </fieldset>

      {compatibleModels === null ? (
        compatibleError ? (
          <div className="mt-3 grid justify-items-start gap-2">
            <p className="text-sm text-content-primary">{compatibleError}</p>
            <Button size="sm" variant="neutral" disabled={busy} onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : (
          <p className="mt-3 text-sm text-content-secondary" role="status">
            Loading the account’s models…
          </p>
        )
      ) : (
        <div className="mt-3 grid gap-2">
          {groups.map((group) => (
            <ProviderGroup
              key={group.provider}
              group={group}
              defaultId={defaultId}
              isAllowed={isAllowed}
              canManage={canManage}
              disabled={disabled}
              onChange={change}
            />
          ))}
          {unavailable.length > 0 ? (
            <p className="text-xs text-content-tertiary">
              {unavailable.length === 1
                ? '1 allowed model isn’t available in this account right now, for example because its provider key was removed. It stays allowed.'
                : `${unavailable.length} allowed models aren’t available in this account right now, for example because their provider key was removed. They stay allowed.`}
            </p>
          ) : null}
        </div>
      )}

      {canManage && dirty ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
            Save models
          </Button>
          <Button size="sm" variant="subtle" disabled={busy} onClick={() => setDraft(null)}>
            Discard changes
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** One provider's models, with "Allow all" and "Allow none" for the group. */
function ProviderGroup({
  group,
  defaultId,
  isAllowed,
  canManage,
  disabled,
  onChange,
}: {
  group: Group;
  defaultId: string;
  isAllowed: (id: string) => boolean;
  canManage: boolean;
  disabled: boolean;
  onChange: (ids: readonly string[], allowed: boolean) => void;
}) {
  const [open, setOpen] = useState(group.models.length <= MAX_OPEN_GROUP_MODELS);
  const ids = group.models.map(({ id }) => id);
  const allowedCount = ids.filter(isAllowed).length;
  const listId = `allowed-models-${group.provider}`;
  return (
    <div className="rounded-md border border-bolt-elements-borderColor">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
        <button
          type="button"
          className="flex min-w-0 grow items-center gap-2 py-0.5 text-left"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen(!open)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={classNames('size-4 shrink-0 text-content-tertiary transition-transform', { 'rotate-90': open })}
          />
          <span className="text-sm font-medium text-content-primary">{group.label}</span>
          <span className="text-xs text-content-tertiary">
            {allowedCount} of {ids.length} allowed
          </span>
        </button>
        {canManage ? (
          <span className="flex items-center gap-1">
            <Button
              size="xs"
              variant="subtle"
              disabled={disabled || allowedCount === ids.length}
              onClick={() => onChange(ids, true)}
            >
              Allow all
            </Button>
            <Button
              size="xs"
              variant="subtle"
              disabled={disabled || ids.every((id) => id === defaultId || !isAllowed(id))}
              onClick={() => onChange(ids, false)}
            >
              Allow none
            </Button>
          </span>
        ) : null}
      </div>
      {open ? (
        <ul
          id={listId}
          className="grid divide-y divide-bolt-elements-borderColor border-t border-bolt-elements-borderColor"
        >
          {group.models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              isDefault={model.id === defaultId}
              allowed={isAllowed(model.id)}
              disabled={disabled}
              onChange={(allowed) => onChange([model.id], allowed)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ModelRow({
  model,
  isDefault,
  allowed,
  disabled,
  onChange,
}: {
  model: BuilderModel;
  isDefault: boolean;
  allowed: boolean;
  disabled: boolean;
  onChange: (allowed: boolean) => void;
}) {
  const facts = [
    // About three words to four tokens: how much text the model can work with at once.
    `Works with about ${formatTokens(Math.round(model.contextTokens * 0.75))} words at once`,
    ...(model.reasoning ? ['Thinks before answering'] : []),
    ...(model.vision ? ['Reads images'] : []),
  ];
  return (
    <li>
      <label
        className="flex min-w-0 cursor-pointer items-start gap-2.5 px-3 py-2 has-[:disabled]:cursor-default"
        title={
          isDefault ? 'The default model is always allowed. Choose another default above to leave it out.' : undefined
        }
      >
        <input
          type="checkbox"
          className="mt-0.5 shrink-0"
          checked={allowed || isDefault}
          disabled={disabled || isDefault}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="min-w-0 grow">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm text-content-primary">{model.label}</span>
            {isDefault ? <StatusBadge tone="success">Default</StatusBadge> : null}
            {model.requiresPaid ? <StatusBadge tone="warning">Needs Workers Paid</StatusBadge> : null}
          </span>
          <span className="mt-0.5 block text-xs text-content-tertiary">{facts.join(' · ')}</span>
        </span>
      </label>
    </li>
  );
}

/** A count written short, as "98K" or "1.3M". */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }
  return `${Math.round(tokens / 1_000)}K`;
}

function groupByProvider(models: readonly BuilderModel[]): Group[] {
  const providers: (GatewayProviderSlug | 'workers')[] = ['workers', ...GATEWAY_PROVIDER_SLUGS];
  return providers.flatMap((provider) => {
    const members = models.filter((model) => (gatewayModelProvider(model.id) ?? 'workers') === provider);
    return members.length === 0
      ? []
      : [
          {
            provider,
            label: provider === 'workers' ? 'Workers AI' : GATEWAY_PROVIDERS[provider].label,
            models: members,
          },
        ];
  });
}

function sameDraft(left: Draft, right: Draft): boolean {
  if (left.mode === 'all' || right.mode === 'all') {
    return left.mode === right.mode;
  }
  return left.ids.size === right.ids.size && [...left.ids].every((id) => right.ids.has(id));
}
