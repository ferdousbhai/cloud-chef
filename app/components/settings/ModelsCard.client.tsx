import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { Button } from '~/components/ui/primitives/Button';
import type { CloudflareAuthSession } from '~/lib/.server/auth';
import { authClient, createCloudflareReturnURL, signInWithCloudflare } from '~/lib/auth-client';
import {
  builderModelCatalogRefusalStore,
  builderModelCatalogStatusStore,
  builderModelsStore,
  fetchCompatibleBuilderModels,
  loadBuilderModelCatalog,
  reloadBuilderModelCatalog,
} from '~/lib/stores/builder-model.client';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  type BuilderModel,
  GATEWAY_PROVIDERS,
  GATEWAY_PROVIDER_SLUGS,
  gatewayModelProvider,
  isBuilderModelId,
  modelIdLabel,
  type GatewayProviderSlug,
} from '~/lib/workers-ai-model';
import { AllowedModelsSection } from './AllowedModelsSection.client';
import { errorFeedback, FeedbackLine, noteFeedback, type Feedback } from './Feedback';
import { SettingsCard, StatusBadge } from './SettingsLayout';
import { getJson, messageOf, postJson } from '~/lib/json-request';

const providerKeySchema = z.object({
  provider: z.enum(GATEWAY_PROVIDER_SLUGS),
  key: z.object({ alias: z.string(), secretPreview: z.string().nullable(), addedByCloudChef: z.boolean() }).nullable(),
});

const keysSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), providers: z.array(providerKeySchema) }),
  z.object({ status: z.literal('reauthorization_required') }),
  z.object({ status: z.literal('unknown') }),
]);

const modelChoicesSchema = z.object({
  defaultModelId: z.string().nullable(),
  allowedModelIds: z.array(z.string()).nullable(),
});

const settingsSchema = modelChoicesSchema.extend({
  canManage: z.boolean(),
  keys: keysSchema,
});

const keysResponseSchema = z.object({ keys: keysSchema });
const linkResponseSchema = z.object({
  keys: keysSchema,
  authenticationTurnedOn: z.boolean(),
  previousKeysRemain: z.boolean().catch(false),
});

type Settings = z.infer<typeof settingsSchema>;
type ProviderKey = z.infer<typeof providerKeySchema>;

const PATH = '/api/settings/models';
/** The select's value for "no choice": CloudChef's own default. */
const CLOUDCHEF_DEFAULT = '';

const PREVIOUS_KEYS_REMAIN_NOTE =
  'The key it replaced could not be removed just now; remove it from the default AI Gateway in the Cloudflare dashboard, or save the key here again.';

const AUTHENTICATION_TURNED_ON_NOTE =
  'Authentication is now on for this account’s default AI Gateway. CloudChef is unaffected; your own apps calling this gateway over HTTP now need a gateway token.';

/**
 * The models of the Cloudflare account the person builds in: the one everyone starts on, which of them the
 * picker offers, and each AI Gateway provider's key, with which that provider's models run. A team's admins
 * (or the person whose own account it is) change them; everyone can still pick among the allowed models in
 * the builder.
 */
export function ModelsCard() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);
  const models = useStore(builderModelsStore);
  const catalogStatus = useStore(builderModelCatalogStatusStore);
  const catalogRefusal = useStore(builderModelCatalogRefusalStore);
  const { data: session } = authClient.useSession();
  const accountLabel = workspaceLabel(session?.context ?? null);

  const [compatibleModels, setCompatibleModels] = useState<BuilderModel[] | null>(null);
  const [compatibleError, setCompatibleError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setSettings(await getJson(PATH, settingsSchema));
  }, []);

  /** Every model the account could offer, which follows the provider keys it has. */
  const refreshCompatible = useCallback(async () => {
    setCompatibleError(null);
    try {
      setCompatibleModels(await fetchCompatibleBuilderModels());
    } catch (failure) {
      setCompatibleModels(null);
      setCompatibleError(messageOf(failure, 'The account’s models could not be listed just now.'));
    }
  }, []);

  useEffect(() => {
    refresh().catch((failure) => {
      setFeedback(errorFeedback(messageOf(failure, 'Unable to load models.')));
    });
    void loadBuilderModelCatalog();
    void refreshCompatible();
  }, [refresh, refreshCompatible]);

  /** Runs one change and says how it went (a null note says nothing); true when it went through. */
  const act = async (operation: () => Promise<string | null>, { refreshOnFailure = false } = {}): Promise<boolean> => {
    setBusy(true);
    setFeedback(null);
    try {
      const note = await operation();
      setFeedback(note === null ? null : noteFeedback(note));
      return true;
    } catch (failure) {
      setFeedback(errorFeedback(messageOf(failure, 'That did not work. Try again.')));
      if (refreshOnFailure) {
        // A failed change may have gone partway in Cloudflare: show the keys as they are now.
        await refresh().catch(() => undefined);
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const retry = () =>
    act(async () => {
      await refresh();
      return null;
    });

  const link = (provider: GatewayProviderSlug, apiKey: string) =>
    act(
      async () => {
        const { keys, authenticationTurnedOn, previousKeysRemain } = await postJson(
          `${PATH}/keys/link`,
          { provider, apiKey },
          linkResponseSchema,
        );
        setSettings((current) => (current ? { ...current, keys } : current));
        void reloadBuilderModelCatalog();
        void refreshCompatible();
        return [
          `${GATEWAY_PROVIDERS[provider].label} is linked. Its models appear in the model picker within a minute.`,
          ...(previousKeysRemain ? [PREVIOUS_KEYS_REMAIN_NOTE] : []),
          ...(authenticationTurnedOn ? [AUTHENTICATION_TURNED_ON_NOTE] : []),
        ].join(' ');
      },
      { refreshOnFailure: true },
    );

  const unlink = (provider: GatewayProviderSlug) =>
    act(
      async () => {
        const { keys } = await postJson(`${PATH}/keys/unlink`, { provider }, keysResponseSchema);
        setSettings((current) => (current ? { ...current, keys } : current));
        void reloadBuilderModelCatalog();
        void refreshCompatible();
        return `CloudChef’s ${GATEWAY_PROVIDERS[provider].label} key is removed, and deleted from your Secrets Store.`;
      },
      { refreshOnFailure: true },
    );

  const chooseDefault = (value: string) =>
    act(
      async () => {
        const choices = await postJson(
          `${PATH}/default`,
          { modelId: value === CLOUDCHEF_DEFAULT ? null : value },
          modelChoicesSchema,
        );
        setSettings((current) => (current ? { ...current, ...choices } : current));
        // The catalog names the default, and new chats in this browser start on the one it names.
        void reloadBuilderModelCatalog();
        return 'Saved. New chats start on this model; anyone can still switch.';
      },
      { refreshOnFailure: true },
    );

  const chooseAllowed = (modelIds: string[] | null) =>
    act(
      async () => {
        const choices = await postJson(`${PATH}/allowed`, { modelIds }, modelChoicesSchema);
        setSettings((current) => (current ? { ...current, ...choices } : current));
        // The picker's catalog lists only the allowed models.
        void reloadBuilderModelCatalog();
        return modelIds === null
          ? 'Saved. The model picker offers every compatible model, including ones added later.'
          : `Saved. The model picker offers ${modelIds.length === 1 ? 'this 1 model' : `these ${modelIds.length} models`}. A chat already open on a model left out moves to an allowed one when it's reopened, or after its next message is refused.`;
      },
      { refreshOnFailure: true },
    );

  // The chosen default may be a model the account no longer offers (its key removed since): still shown.
  const choices = models.some(({ id }) => id === settings?.defaultModelId)
    ? models
    : [
        ...models,
        ...(settings?.defaultModelId
          ? [{ id: settings.defaultModelId, label: modelIdLabel(settings.defaultModelId) }]
          : []),
      ];

  return (
    <SettingsCard id="models" title="Models" description={accountLabel ? `For ${accountLabel}.` : undefined}>
      {settings === null ? (
        feedback ? (
          <div className="mt-2">
            <Button size="sm" variant="neutral" disabled={busy} onClick={() => void retry()}>
              Retry
            </Button>
          </div>
        ) : (
          <p className="mt-3 text-sm text-content-secondary" role="status">
            Loading…
          </p>
        )
      ) : (
        <>
          <div className="mt-4 grid min-w-0 gap-1.5">
            <label className="text-sm font-medium text-content-primary" htmlFor="default-model">
              Default model
            </label>
            <select
              id="default-model"
              className="w-full max-w-md rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1.5 text-sm text-content-primary"
              value={settings.defaultModelId ?? CLOUDCHEF_DEFAULT}
              disabled={!settings.canManage || busy}
              onChange={(event) => void chooseDefault(event.target.value)}
            >
              {/* While models are chosen one by one the default is a model on the list, by name. */}
              {settings.allowedModelIds === null ? (
                <option value={CLOUDCHEF_DEFAULT}>
                  CloudChef’s default ({modelIdLabel(CLOUDFLARE_WORKERS_AI_MODEL)})
                </option>
              ) : null}
              {choices.map((model) => {
                const provider = isBuilderModelId(model.id) ? gatewayModelProvider(model.id) : null;
                return (
                  <option key={model.id} value={model.id}>
                    {model.label}
                    {provider ? ` (${GATEWAY_PROVIDERS[provider].label})` : ''}
                  </option>
                );
              })}
            </select>
            <p className="text-xs text-content-tertiary">
              {catalogRefusal
                ? catalogRefusal
                : catalogStatus === 'error'
                  ? 'The account’s model list could not be loaded just now.'
                  : catalogStatus === 'stale'
                    ? 'The account’s model list could not be refreshed just now, so these are the models it last listed.'
                    : settings.canManage
                      ? 'New chats start on this model. Anyone can switch in the builder.'
                      : 'Chosen by this team’s admins. You can switch in the builder.'}
            </p>
          </div>

          <AllowedModelsSection
            allowedModelIds={settings.allowedModelIds}
            defaultModelId={settings.defaultModelId}
            compatibleModels={compatibleModels}
            compatibleError={compatibleError}
            canManage={settings.canManage}
            busy={busy}
            onSave={chooseAllowed}
            onRetry={() => void refreshCompatible()}
          />

          <h3 className="mt-6 text-sm font-medium text-content-primary">Provider keys</h3>
          <p className="mt-1 text-xs text-content-tertiary">
            Kept in this account’s Cloudflare Secrets Store and used through its AI Gateway. The provider bills its key.
          </p>
          {settings.keys.status === 'ready' ? (
            <ul className="mt-3 grid divide-y divide-bolt-elements-borderColor rounded-md border border-bolt-elements-borderColor">
              {settings.keys.providers.map((providerKey) => (
                <ProviderKeyRow
                  key={providerKey.provider}
                  providerKey={providerKey}
                  canManage={settings.canManage}
                  busy={busy}
                  onLink={(apiKey) => link(providerKey.provider, apiKey)}
                  onUnlink={() => unlink(providerKey.provider)}
                />
              ))}
            </ul>
          ) : settings.keys.status === 'unknown' ? (
            <div className="mt-2 grid justify-items-start gap-2">
              <p className="text-sm text-content-primary">
                Cloudflare couldn’t be asked just now which keys this account has.
              </p>
              <Button size="sm" variant="neutral" disabled={busy} onClick={() => void retry()}>
                Retry
              </Button>
            </div>
          ) : settings.canManage ? (
            <ReauthorizeForKeys />
          ) : (
            <p className="mt-2 text-sm text-content-secondary">
              This account’s admins need to reauthorize Cloudflare before keys can be added.
            </p>
          )}
          {settings.canManage && settings.keys.status === 'ready' ? (
            <p className="mt-2 text-xs text-content-tertiary">
              Adding a key turns on authentication and a Secrets Store for the default AI Gateway if they’re off.
            </p>
          ) : null}
        </>
      )}
      <FeedbackLine feedback={feedback} />
    </SettingsCard>
  );
}

function ProviderKeyRow({
  providerKey: { provider, key },
  canManage,
  busy,
  onLink,
  onUnlink,
}: {
  providerKey: ProviderKey;
  canManage: boolean;
  busy: boolean;
  onLink: (apiKey: string) => Promise<boolean>;
  onUnlink: () => Promise<boolean>;
}) {
  const [apiKey, setApiKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const { label } = GATEWAY_PROVIDERS[provider];
  const secretTail = key?.secretPreview?.replace(/^\*+/, '');
  const details = key
    ? [
        secretTail ? `Key ending ${secretTail}` : 'Key linked',
        key.alias === 'default' ? 'default alias' : `alias ${key.alias}`,
        key.addedByCloudChef ? 'added in CloudChef' : 'added in Cloudflare',
      ].join(' · ')
    : null;
  const form = (
    <form
      className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void onLink(apiKey).then((linked) => {
          // A refused key stays in the field, to correct or try again.
          if (linked) {
            setApiKey('');
            setReplacing(false);
          }
        });
      }}
    >
      <input
        type="password"
        autoComplete="off"
        aria-label={`${label} API key`}
        placeholder={`Paste ${/^(?:[aeiou]|xai)/i.test(label) ? 'an' : 'a'} ${label} API key`}
        className="min-w-0 grow basis-40 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2.5 py-1.5 text-sm text-content-primary outline-none placeholder:text-content-tertiary focus-visible:border-accent-500"
        value={apiKey}
        disabled={busy}
        // Opened by "Replace key", so the field is where the person is about to type.
        autoFocus={replacing}
        onChange={(event) => setApiKey(event.target.value)}
      />
      <Button size="sm" variant="neutral" type="submit" disabled={busy || apiKey.trim().length === 0}>
        {key ? 'Replace' : 'Save'}
      </Button>
      {key && replacing ? (
        <Button
          size="sm"
          variant="subtle"
          disabled={busy}
          onClick={() => {
            setReplacing(false);
            setApiKey('');
          }}
        >
          Cancel
        </Button>
      ) : null}
    </form>
  );
  return (
    <li className="grid min-w-0 gap-2 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-32 items-center gap-2 sm:w-48">
          <p className="text-sm font-medium text-content-primary">{label}</p>
          {key ? <StatusBadge tone="success">Linked</StatusBadge> : <StatusBadge>Not linked</StatusBadge>}
        </div>
        {canManage && (!key || replacing) ? (
          form
        ) : canManage && key ? (
          <div className="ml-auto flex flex-wrap items-center gap-1">
            <Button size="xs" variant="neutral" disabled={busy} onClick={() => setReplacing(true)}>
              Replace key
            </Button>
            {key.addedByCloudChef ? (
              <Button
                size="xs"
                variant="subtle"
                className="!text-content-error"
                disabled={busy}
                onClick={() => void onUnlink()}
              >
                Remove {label} key
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {details ? (
        <p className="text-xs leading-5 text-content-tertiary">
          {details}
          <span> · stored in your Cloudflare account</span>
        </p>
      ) : null}
      {key && replacing && !key.addedByCloudChef ? (
        <p className="text-xs text-content-tertiary">
          Saving a key here replaces the one added in Cloudflare (alias {key.alias}) on the gateway.
        </p>
      ) : null}
    </li>
  );
}

/** The account Settings is showing, as its switcher names it: a team, or the person's own account. */
function workspaceLabel(context: CloudflareAuthSession['context']): string | null {
  if (!context) {
    return null;
  }
  if (context.kind === 'organization') {
    return `the ${context.orgName} team${context.accountName ? ` (Cloudflare account ${context.accountName})` : ''}`;
  }
  return context.accountName ? `your Cloudflare account ${context.accountName}` : 'your own Cloudflare account';
}

/**
 * Reauthorizes the connection this page is showing: a team's (its admins grant it) or the person's own.
 * Connections made before CloudChef could manage AI Gateway keys lack those permissions until then.
 */
function ReauthorizeForKeys() {
  const { data: session } = authClient.useSession();
  const team = session?.context?.kind === 'organization' ? session.context : null;
  const [reauthorizing, setReauthorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reauthorize = async () => {
    setReauthorizing(true);
    setError(null);
    try {
      await signInWithCloudflare(
        createCloudflareReturnURL(window.location.href),
        team ? { organizationId: team.orgId } : {},
      );
    } catch {
      setError('Cloudflare couldn’t be reached. Try again.');
      setReauthorizing(false);
    }
  };
  return (
    <div className="mt-3 grid justify-items-start gap-2 text-sm text-content-secondary">
      <p className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="warning">Needs permission</StatusBadge>
        Reauthorize {team ? `${team.orgName}'s Cloudflare account` : 'Cloudflare'} once to manage AI Gateway keys.
      </p>
      <Button size="sm" variant="primary" loading={reauthorizing} onClick={() => void reauthorize()}>
        Reauthorize Cloudflare
      </Button>
      {error ? (
        <p className="text-bolt-elements-icon-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
