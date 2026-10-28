import { useStore } from '@nanostores/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { CheckIcon, ChevronDownIcon, MagnifyingGlassIcon, PlusIcon } from '@radix-ui/react-icons';
import { useEffect, useMemo, useState } from 'react';
import {
  GATEWAY_PROVIDERS,
  GATEWAY_PROVIDER_SLUGS,
  isBuilderModelId,
  builderModelPublishedTime,
  builderReasoningLevelSchema,
  type BuilderModel,
  type BuilderReasoningLevel,
  olderBuilderModelIds,
} from '~/lib/workers-ai-model';
import {
  type BuilderProvider,
  builderDefaultModelStore,
  builderProviderFor,
  builderProviderStore,
  builderRecentModelsStore,
  setBuilderProvider,
  builderModelFor,
  builderModelCatalogRefusalStore,
  builderModelCatalogStatusStore,
  builderModelsStore,
  builderModelStore,
  builderNewModelsStore,
  builderReasoningChoicesStore,
  builderReasoningLevelFor,
  loadBuilderModelCatalog,
  loadBuilderModelPreference,
  markBuilderModelsSeen,
  orderBuilderModelsForDisplay,
  setBuilderModel,
  setBuilderReasoningLevel,
  syncBuilderModelPreference,
} from '~/lib/stores/builder-model.client';
import { classNames } from '~/utils/classNames';

/** How each effort reads in the picker; "Default" is the absence of one. */
const REASONING_LEVEL_LABELS = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
} as const satisfies Record<BuilderReasoningLevel, string>;
const PROVIDER_DEFAULT_EFFORT = 'default';
/** No level is the provider's own effort, except where it has none (older Claude models). */
const DEFAULT_EFFORT_TITLE = "The provider's own effort, or High for a Claude model that has none.";

/** The catalog dates entries to the day, so the day is all the picker claims. */
function formatModelAddedDate(model: BuilderModel): string | null {
  const published = builderModelPublishedTime(model);
  if (published === Number.NEGATIVE_INFINITY) {
    return null;
  }
  return new Date(published).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function BuilderModelSelector({ disabled = false }: { disabled?: boolean }) {
  const rememberedProvider = useStore(builderProviderStore);
  const recents = useStore(builderRecentModelsStore);
  const [provider, selectProvider] = useState<BuilderProvider | null>(null);
  const [search, setSearch] = useState('');
  const modelId = useStore(builderModelStore);
  const defaultModelId = useStore(builderDefaultModelStore);
  const models = useStore(builderModelsStore);
  const newModels = useStore(builderNewModelsStore);
  const catalogStatus = useStore(builderModelCatalogStatusStore);
  const catalogRefusal = useStore(builderModelCatalogRefusalStore);
  const reasoningChoices = useStore(builderReasoningChoicesStore);
  const model = builderModelFor(modelId, models, reasoningChoices, catalogStatus);
  // A saved model the catalog has not described (still loading, or failed to load) is the one turns
  // run on, so the menu lists it, selected, beside the models it can switch to.
  const currentProvider = builderProviderFor(model);
  const currentProviderLabel = currentProvider === 'workers' ? 'Cloudflare Workers AI' : providerLabel(currentProvider);
  const standingIn = !models.some(({ id }) => id === model.id);
  const reasoningLevels = model.reasoningLevels ?? [];
  const reasoningLevel = builderReasoningLevelFor(model, reasoningChoices);
  // Shown only for a model with efforts to choose from; "Default" is no level chosen.
  const effortLabel =
    reasoningLevels.length === 0
      ? null
      : reasoningLevel === undefined
        ? 'Default'
        : REASONING_LEVEL_LABELS[reasoningLevel];
  const [openRequested, setOpenRequested] = useState(false);
  const open = !disabled && openRequested;
  const orderedModels = orderBuilderModelsForDisplay(standingIn ? [...models, model] : models, defaultModelId);
  const defaultModel = orderedModels.find(({ id }) => id === defaultModelId) ?? model;
  const hasModels = (slug: BuilderProvider) => orderedModels.some((entry) => builderProviderFor(entry) === slug);
  // The default model's provider first, then the other providers with models, Workers AI last.
  const keyedProviders = [...new Set([builderProviderFor(defaultModel), ...ALL_PROVIDERS.filter(hasModels)])];
  const keylessProviders = GATEWAY_PROVIDER_SLUGS.filter((slug) => !hasModels(slug));
  const activeProvider = provider ?? builderProviderFor(model);
  // Only the newest model of each family is listed, and the selected one, so a choice never vanishes.
  const older = olderBuilderModelIds(orderedModels);
  const listedModels = orderedModels.filter((entry) => entry.id === modelId || !older.has(entry.id));
  const recentModels = [...new Set(recents)].flatMap((id) => {
    const recent = orderedModels.find((entry) => entry.id === id);
    return recent && id !== defaultModel.id ? [recent] : [];
  });
  const pins = [defaultModel, ...recentModels];
  const query = search.trim().toLowerCase();
  const searching = query.length > 0;
  const visible = searching
    ? listedModels.filter((entry) => `${entry.label} ${entry.id}`.toLowerCase().includes(query))
    : listedModels.filter((entry) => builderProviderFor(entry) === activeProvider);
  // What was new when this picker last opened. Opening records the sighting, but the badge is the
  // reason the user opened the picker, so it stays legible for the rest of this session.
  const [openedWithNewIds, setOpenedWithNewIds] = useState<readonly BuilderModel['id'][]>([]);
  const newModelIds = useMemo(
    () => new Set([...openedWithNewIds, ...newModels.map(({ id }) => id)]),
    [newModels, openedWithNewIds],
  );

  useEffect(() => {
    loadBuilderModelPreference();
    void loadBuilderModelCatalog();
    window.addEventListener('storage', syncBuilderModelPreference);
    return () => window.removeEventListener('storage', syncBuilderModelPreference);
  }, []);

  // A disabled picker forgets that it was asked open, so enabling it again doesn't reopen it.
  if (disabled && openRequested) {
    setOpenRequested(false);
  }

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          const preferred = provider ?? rememberedProvider;
          selectProvider(
            preferred && orderedModels.some((entry) => builderProviderFor(entry) === preferred)
              ? preferred
              : builderProviderFor(model),
          );
          setSearch('');
          // Opening the picker is the user seeing the list, so nothing here is new to them any more.
          const unseen = builderNewModelsStore.get();
          if (!disabled && unseen.length > 0) {
            setOpenedWithNewIds(unseen.map(({ id }) => id));
            markBuilderModelsSeen();
          }
        }
        setOpenRequested(!disabled && nextOpen);
      }}
    >
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`Builder model. Current: ${model.label} (${currentProviderLabel})${effortLabel === null ? '' : `, reasoning effort ${effortLabel}`}${disabled ? '. Stop or wait for the current response to finish before switching models.' : ''}`}
          className={classNames(
            // A quiet label in the composer toolbar: the prompt is the focus, the model a setting.
            'group inline-flex min-h-7 min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-content-tertiary outline-none transition-colors hover:bg-bolt-elements-background-depth-3 hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-500 disabled:cursor-not-allowed disabled:opacity-50',
            // Sized to its label. A fixed width here truncated the one value this control
            // exists to display.
            'max-w-[16rem]',
          )}
          title={
            disabled
              ? 'Stop or wait for the current response to finish before switching models.'
              : [model.label, model.description, model.id].filter(Boolean).join(' — ')
          }
        >
          <ProviderMark provider={currentProvider} />
          <span className="truncate">{model.label.replace(/\s*\(.*?\)\s*$/, '')}</span>
          {effortLabel !== null && (
            <span className="shrink-0 text-content-tertiary" aria-hidden="true">
              · {effortLabel}
            </span>
          )}
          <ChevronDownIcon
            className="ml-auto size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={10}
          collisionPadding={12}
          onKeyDownCapture={(event) => {
            if (event.key !== 'Tab') {
              return;
            }
            const controls = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                'input, button:not([disabled]), a, [role="menuitemradio"]:not([data-disabled]), [role="menuitem"]',
              ),
            ];
            const focused = controls.findIndex((control) => control === document.activeElement);
            const next = (focused + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
            event.preventDefault();
            event.stopPropagation();
            controls[next]?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (search) {
              event.preventDefault();
              setSearch('');
            }
          }}
          aria-label="Builder model"
          className="z-50 max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-1.5 text-content-primary shadow-panel outline-none"
        >
          {listedModels.length > 8 && (
            <div className="relative mb-1.5">
              <MagnifyingGlassIcon
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-content-tertiary"
              />
              <input
                aria-label="Search models"
                value={search}
                placeholder="Search models"
                className="w-full rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 py-1.5 pl-8 pr-2.5 text-sm text-content-primary outline-none placeholder:text-content-tertiary focus-visible:border-accent-500"
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    event.currentTarget
                      .closest('[role="menu"]')
                      ?.querySelector<HTMLElement>('[role="menuitemradio"]')
                      ?.focus();
                  } else if (event.key !== 'Escape') {
                    event.stopPropagation();
                  }
                }}
              />
            </div>
          )}
          <DropdownMenu.RadioGroup
            value={modelId}
            onValueChange={(value) => {
              if (!disabled && isBuilderModelId(value)) {
                setBuilderModel(value);
                selectProvider(builderProviderFor({ ...model, id: value }));
              }
            }}
          >
            {!searching && (
              // One-click switches: the team default and what this browser picked recently.
              <DropdownMenu.Group aria-label="Quick switch" className="flex flex-wrap gap-1 px-1 pb-1.5 pt-0.5">
                {pins.map((entry) => (
                  <PinnedItem
                    key={entry.id}
                    model={entry}
                    label={entry.id === defaultModel.id ? 'Team default' : 'Recent'}
                    disabled={disabled}
                  />
                ))}
              </DropdownMenu.Group>
            )}
            {!searching && (
              <div
                role="tablist"
                aria-label="Model providers"
                className="mx-1 mb-1 flex gap-0.5 overflow-x-auto rounded-md bg-bolt-elements-background-depth-2 p-0.5 [scrollbar-width:none]"
              >
                {keyedProviders.map((slug) => {
                  const label = providerLabel(slug);
                  return (
                    <button
                      key={slug}
                      type="button"
                      role="tab"
                      id={`builder-provider-${slug}`}
                      aria-controls="builder-provider-models"
                      aria-selected={activeProvider === slug}
                      tabIndex={activeProvider === slug ? 0 : -1}
                      className={classNames(
                        'shrink-0 grow rounded px-2.5 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent-500',
                        activeProvider === slug
                          ? 'bg-bolt-elements-background-depth-1 text-content-primary shadow-sm'
                          : 'text-content-secondary hover:text-content-primary',
                      )}
                      onClick={() => {
                        selectProvider(slug);
                        setBuilderProvider(slug);
                      }}
                      onKeyDown={(event) => {
                        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                          return;
                        }
                        event.preventDefault();
                        event.stopPropagation();
                        const tabs = [
                          ...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ??
                            []),
                        ];
                        const index = tabs.indexOf(event.currentTarget);
                        const next =
                          event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? tabs.length - 1
                              : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                        tabs[next]?.click();
                        tabs[next]?.focus();
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
                {keylessProviders.length > 0 && (
                  <a
                    href="/settings#models"
                    aria-label={`Add a key for ${keylessProviders.map(providerLabel).join(' or ')} in Settings`}
                    title={`Add a key for ${keylessProviders.map(providerLabel).join(' or ')} in Settings → Models to use their models`}
                    className="inline-flex shrink-0 items-center justify-center rounded px-2 py-1.5 text-content-tertiary outline-none transition-colors hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-500"
                  >
                    <PlusIcon aria-hidden="true" className="size-3.5" />
                  </a>
                )}
              </div>
            )}
            <div
              role={searching ? 'group' : 'tabpanel'}
              id="builder-provider-models"
              aria-label={searching ? 'Search results' : undefined}
              aria-labelledby={searching ? undefined : `builder-provider-${activeProvider}`}
            >
              {visible.map((entry) => (
                <ModelItem
                  key={entry.id}
                  model={entry}
                  disabled={disabled}
                  defaultModelId={defaultModelId}
                  newModelIds={newModelIds}
                  showProvider={searching}
                />
              ))}
            </div>
            {searching && visible.length === 0 && (
              <p className="px-3 py-3 text-center text-xs text-content-tertiary">No models match “{search.trim()}”.</p>
            )}
          </DropdownMenu.RadioGroup>
          {reasoningLevels.length > 0 && (
            <div className="mt-1.5 border-t border-bolt-elements-borderColor px-1 pb-0.5 pt-2">
              <DropdownMenu.Label
                id="builder-reasoning-effort-label"
                className="px-1 pb-1.5 text-xs font-semibold uppercase tracking-widest text-content-tertiary"
              >
                Reasoning effort · {model.label}
              </DropdownMenu.Label>
              <DropdownMenu.RadioGroup
                aria-labelledby="builder-reasoning-effort-label"
                value={reasoningLevel ?? PROVIDER_DEFAULT_EFFORT}
                onValueChange={(value) => {
                  if (disabled) {
                    return;
                  }
                  const level = builderReasoningLevelSchema.safeParse(value);
                  setBuilderReasoningLevel(model.id, level.success ? level.data : undefined);
                }}
                className="flex flex-wrap gap-1"
              >
                <EffortItem
                  value={PROVIDER_DEFAULT_EFFORT}
                  label="Default"
                  title={DEFAULT_EFFORT_TITLE}
                  disabled={disabled}
                />
                {reasoningLevels.map((level) => (
                  <EffortItem key={level} value={level} label={REASONING_LEVEL_LABELS[level]} disabled={disabled} />
                ))}
              </DropdownMenu.RadioGroup>
            </div>
          )}
          {catalogStatus === 'error' && (
            <p role="status" className="mx-2 mb-1 mt-2 text-xs leading-5 text-content-tertiary">
              {catalogRefusal
                ? catalogRefusal
                : standingIn
                  ? `The model list couldn't be loaded just now. New messages still use your saved model, ${model.label}, if it's still allowed when you send; choose the default model to switch.`
                  : "The model list couldn't be loaded just now, so only the default model is available."}
            </p>
          )}
          {catalogStatus === 'stale' && (
            <p role="status" className="mx-2 mb-1 mt-2 text-xs leading-5 text-content-tertiary">
              {catalogRefusal ??
                "The model list couldn't be refreshed just now, so these are the models it last listed."}
            </p>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** One effort choice: a compact chip, 32px tall so it is still an easy target on a phone. */
function EffortItem({
  value,
  label,
  title,
  disabled,
}: {
  value: string;
  label: string;
  title?: string;
  disabled: boolean;
}) {
  return (
    <DropdownMenu.RadioItem
      value={value}
      textValue={label}
      title={title}
      disabled={disabled}
      // Choosing an effort keeps the menu open, so the model list below stays in reach.
      onSelect={(event) => event.preventDefault()}
      className="inline-flex min-h-8 cursor-pointer select-none items-center rounded-full border border-bolt-elements-borderColor px-2 text-xs font-medium text-content-secondary outline-none transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-bolt-elements-background-depth-2 data-[state=checked]:border-accent-500 data-[state=checked]:bg-accent-500/10 data-[state=checked]:text-content-accent"
    >
      {label}
    </DropdownMenu.RadioItem>
  );
}

/** A provider's name as the tabs show it; Workers AI is CloudChef's own, so "Cloudflare" is implied. */
/** Every provider in tab order: the gateway's in `GATEWAY_PROVIDERS` order, then Workers AI. */
const ALL_PROVIDERS: readonly BuilderProvider[] = [...GATEWAY_PROVIDER_SLUGS, 'workers'];

function providerLabel(provider: BuilderProvider): string {
  return provider === 'workers' ? 'Workers AI' : GATEWAY_PROVIDERS[provider].label;
}

/** A small monogram standing in for the provider's logo, which CloudChef does not ship. */
function ProviderMark({ provider }: { provider: BuilderProvider }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-sm bg-bolt-elements-background-depth-3 px-1 text-xs font-semibold leading-none text-content-secondary"
    >
      {provider === 'workers' ? 'CF' : GATEWAY_PROVIDERS[provider].mark}
    </span>
  );
}

/** A one-click switch to the team default or a recent model, as a chip above the provider tabs. */
function PinnedItem({ model, label, disabled }: { model: BuilderModel; label: string; disabled: boolean }) {
  return (
    <DropdownMenu.RadioItem
      value={model.id}
      textValue={model.label}
      title={`${label}: ${model.label}`}
      aria-label={`${model.label}, ${label.toLowerCase()}`}
      disabled={disabled}
      className="inline-flex min-h-8 min-w-0 max-w-full cursor-pointer select-none items-center gap-1.5 rounded-full border border-bolt-elements-borderColor py-1 pl-1 pr-2.5 text-xs outline-none transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-bolt-elements-background-depth-2 data-[state=checked]:border-accent-500 data-[state=checked]:bg-accent-500/10"
    >
      <ProviderMark provider={builderProviderFor(model)} />
      <span className="truncate font-medium text-content-primary">{model.label}</span>
      {label === 'Team default' && <span className="shrink-0 text-content-tertiary">default</span>}
    </DropdownMenu.RadioItem>
  );
}

function ModelItem({
  model,
  disabled,
  defaultModelId,
  newModelIds,
  showProvider = false,
}: {
  model: BuilderModel;
  disabled: boolean;
  defaultModelId: BuilderModel['id'];
  newModelIds: ReadonlySet<BuilderModel['id']>;
  /** Search results mix providers, so each row says whose model it is. */
  showProvider?: boolean;
}) {
  const addedOn = formatModelAddedDate(model);
  return (
    <DropdownMenu.RadioItem
      value={model.id}
      textValue={model.label}
      disabled={disabled}
      className="group/model relative flex min-h-12 cursor-pointer select-none items-center gap-3 rounded-md px-2.5 py-2 outline-none transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-bolt-elements-background-depth-2 data-[state=checked]:bg-bolt-elements-item-backgroundAccent"
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 group-data-[state=checked]/model:border-accent-500 group-data-[state=checked]/model:bg-accent-500 group-data-[state=checked]/model:text-white">
        <DropdownMenu.ItemIndicator>
          <CheckIcon className="size-3.5" />
        </DropdownMenu.ItemIndicator>
      </span>
      <span className="min-w-0 grow">
        <span className="flex flex-wrap items-center gap-2">
          {showProvider && <ProviderMark provider={builderProviderFor(model)} />}
          <span className="break-words text-sm font-semibold text-content-primary">{model.label}</span>
          {model.id === defaultModelId && (
            <span className="shrink-0 rounded border border-accent-500/30 bg-accent-500/10 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-content-accent">
              Default
            </span>
          )}
          {newModelIds.has(model.id) && (
            <span className="shrink-0 rounded border border-util-success/30 bg-util-success/10 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-content-success">
              New
            </span>
          )}
          {model.requiresPaid && (
            <span className="shrink-0 rounded border border-util-warning/30 bg-util-warning/10 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-content-warning">
              Paid
            </span>
          )}
        </span>
        {(model.description || addedOn !== null) && (
          <span className="mt-0.5 line-clamp-2 block text-xs leading-4 text-content-secondary">
            {model.description}
            {addedOn === null ? null : (
              <span className="text-content-tertiary">
                {model.description ? ' · ' : ''}added {addedOn}
              </span>
            )}
          </span>
        )}
      </span>
    </DropdownMenu.RadioItem>
  );
}
