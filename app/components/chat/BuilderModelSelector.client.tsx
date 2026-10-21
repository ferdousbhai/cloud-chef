import { useStore } from '@nanostores/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { CheckIcon, ChevronDownIcon } from '@radix-ui/react-icons';
import { useEffect, useMemo, useState } from 'react';
import {
  GATEWAY_PROVIDERS,
  GATEWAY_PROVIDER_SLUGS,
  gatewayModelProvider,
  getBuilderModel,
  isBuilderModelId,
  builderModelPublishedTime,
  type BuilderModel,
} from '~/lib/workers-ai-model';
import {
  builderDefaultModelStore,
  builderModelCatalogStatusStore,
  builderModelsStore,
  builderModelStore,
  builderNewModelsStore,
  loadBuilderModelCatalog,
  loadBuilderModelPreference,
  markBuilderModelsSeen,
  orderBuilderModelsForDisplay,
  setBuilderModel,
  syncBuilderModelPreference,
} from '~/lib/stores/builder-model.client';
import { classNames } from '~/utils/classNames';

/** A provider offering more models than this is shown as its own submenu, so the list stays usable. */
const COLLAPSED_GROUP_SIZE = 24;

/** The catalog dates entries to the day, so the day is all the picker claims. */
function formatModelAddedDate(model: BuilderModel): string | null {
  const published = builderModelPublishedTime(model);
  if (published === Number.NEGATIVE_INFINITY) {
    return null;
  }
  return new Date(published).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function BuilderModelSelector({
  disabled = false,
  catalogLoader = loadBuilderModelCatalog,
}: {
  disabled?: boolean;
  catalogLoader?: () => void | Promise<void>;
}) {
  const modelId = useStore(builderModelStore);
  const defaultModelId = useStore(builderDefaultModelStore);
  const models = useStore(builderModelsStore);
  const newModels = useStore(builderNewModelsStore);
  const catalogStatus = useStore(builderModelCatalogStatusStore);
  const model = getBuilderModel(modelId, models);
  const [openRequested, setOpenRequested] = useState(false);
  const open = !disabled && openRequested;
  const orderedModels = useMemo(() => orderBuilderModelsForDisplay(models, defaultModelId), [defaultModelId, models]);
  // What was new when this picker last opened. Opening records the sighting, but the badge is the
  // reason the user opened the picker, so it stays legible for the rest of this session.
  const [openedWithNewIds, setOpenedWithNewIds] = useState<readonly BuilderModel['id'][]>([]);
  const newModelIds = useMemo(
    () => new Set([...openedWithNewIds, ...newModels.map(({ id }) => id)]),
    [newModels, openedWithNewIds],
  );

  useEffect(() => {
    loadBuilderModelPreference();
    void catalogLoader();
    window.addEventListener('storage', syncBuilderModelPreference);
    return () => window.removeEventListener('storage', syncBuilderModelPreference);
  }, [catalogLoader]);

  // Opening the picker is the user seeing the list, so nothing here is new to them any more.
  useEffect(() => {
    const unseen = builderNewModelsStore.get();
    if (!open || unseen.length === 0) {
      return;
    }
    setOpenedWithNewIds(unseen.map(({ id }) => id));
    markBuilderModelsSeen();
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpenRequested(false);
    }
  }, [disabled]);

  return (
    <DropdownMenu.Root open={open} onOpenChange={(nextOpen) => setOpenRequested(!disabled && nextOpen)}>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`Builder model. Current: ${model.label}${disabled ? '. Stop or wait for the current response to finish before switching models.' : ''}`}
          className={classNames(
            // A quiet label in the composer toolbar: the prompt is the focus, the model a setting.
            'group inline-flex min-h-7 min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-content-tertiary outline-none transition-colors hover:bg-bolt-elements-background-depth-3 hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-500 disabled:cursor-not-allowed disabled:opacity-50',
            // Sized to its label. A fixed width here truncated the one value this control
            // exists to display.
            'max-w-[13rem]',
          )}
          title={
            disabled
              ? 'Stop or wait for the current response to finish before switching models.'
              : `${model.label} — ${model.description} ${model.id}`
          }
        >
          <span className="truncate">{model.label}</span>
          <ChevronDownIcon
            className="ml-auto size-3.5 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180"
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
          aria-label="Builder model"
          className="z-50 max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-1.5 text-content-primary shadow-panel outline-none"
        >
          <DropdownMenu.RadioGroup
            value={modelId}
            onValueChange={(value) => {
              if (!disabled && isBuilderModelId(value)) {
                setBuilderModel(value);
              }
            }}
          >
            <ModelGroup
              label="Cloudflare Workers AI"
              models={orderedModels.filter(({ id }) => gatewayModelProvider(id) === null)}
              disabled={disabled}
              defaultModelId={defaultModelId}
              newModelIds={newModelIds}
            />
            {GATEWAY_PROVIDER_SLUGS.map((provider) => {
              const providerModels = orderedModels.filter(({ id }) => gatewayModelProvider(id) === provider);
              return (
                <ModelGroup
                  key={provider}
                  label={GATEWAY_PROVIDERS[provider].label}
                  models={providerModels}
                  disabled={disabled}
                  defaultModelId={defaultModelId}
                  newModelIds={newModelIds}
                  collapsed={providerModels.length > COLLAPSED_GROUP_SIZE}
                />
              );
            })}
          </DropdownMenu.RadioGroup>
          {catalogStatus === 'error' && (
            <p role="status" className="mx-2 mb-1 mt-2 text-xs leading-5 text-content-tertiary">
              Catalog unavailable. Only the default model is available.
            </p>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ModelGroup({
  label,
  models,
  disabled,
  defaultModelId,
  newModelIds,
  collapsed = false,
}: {
  label: string;
  models: readonly BuilderModel[];
  disabled: boolean;
  defaultModelId: BuilderModel['id'];
  newModelIds: ReadonlySet<BuilderModel['id']>;
  /** Shown as a submenu that opens on demand, for a provider offering many models. */
  collapsed?: boolean;
}) {
  if (models.length === 0) {
    return null;
  }
  const items = models.map((model) => (
    <ModelItem
      key={model.id}
      model={model}
      disabled={disabled}
      defaultModelId={defaultModelId}
      newModelIds={newModelIds}
    />
  ));
  if (collapsed) {
    return (
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger className="flex min-h-10 cursor-pointer select-none items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm font-semibold text-content-primary outline-none data-[highlighted]:bg-bolt-elements-background-depth-2 data-[state=open]:bg-bolt-elements-background-depth-2">
          <span>{label}</span>
          <span className="text-xs font-normal text-content-tertiary">{models.length} models</span>
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent
            sideOffset={6}
            collisionPadding={12}
            aria-label={`${label} models`}
            className="z-50 max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-1.5 text-content-primary shadow-panel outline-none"
          >
            {items}
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>
    );
  }
  return (
    <DropdownMenu.Group>
      <DropdownMenu.Label className="px-3 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-content-tertiary">
        {label}
      </DropdownMenu.Label>
      {items}
    </DropdownMenu.Group>
  );
}

function ModelItem({
  model,
  disabled,
  defaultModelId,
  newModelIds,
}: {
  model: BuilderModel;
  disabled: boolean;
  defaultModelId: BuilderModel['id'];
  newModelIds: ReadonlySet<BuilderModel['id']>;
}) {
  const addedOn = formatModelAddedDate(model);
  return (
    <DropdownMenu.RadioItem
      value={model.id}
      textValue={model.label}
      disabled={disabled}
      className="group/model relative flex min-h-14 cursor-pointer select-none items-center gap-3 rounded-lg px-3 py-2.5 outline-none transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-bolt-elements-background-depth-2 data-[state=checked]:bg-bolt-elements-item-backgroundAccent"
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 group-data-[state=checked]/model:border-accent-500 group-data-[state=checked]/model:bg-accent-500 group-data-[state=checked]/model:text-white">
        <DropdownMenu.ItemIndicator>
          <CheckIcon className="size-3.5" />
        </DropdownMenu.ItemIndicator>
      </span>
      <span className="min-w-0 grow">
        <span className="flex flex-wrap items-center gap-2">
          <span className="break-words text-sm font-semibold text-content-primary">{model.label}</span>
          {model.id === defaultModelId && (
            <span className="shrink-0 rounded border border-accent-500/30 bg-accent-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-content-accent">
              Default
            </span>
          )}
          {newModelIds.has(model.id) && (
            <span className="shrink-0 rounded border border-util-success/30 bg-util-success/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-content-success">
              New
            </span>
          )}
          {model.requiresPaid && (
            <span className="shrink-0 rounded border border-util-warning/30 bg-util-warning/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-content-warning">
              Paid
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-xs leading-4 text-content-secondary">
          {model.description}
          {addedOn === null ? null : <span className="text-content-tertiary"> · added {addedOn}</span>}
        </span>
      </span>
    </DropdownMenu.RadioItem>
  );
}
