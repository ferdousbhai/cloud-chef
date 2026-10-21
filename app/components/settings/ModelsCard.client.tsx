import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { Button } from '~/components/ui/primitives/Button';
import type { CloudflareAuthSession } from '~/lib/.server/auth';
import { authClient, createCloudflareReturnURL, signInWithCloudflare } from '~/lib/auth-client';
import {
  builderModelCatalogStatusStore,
  builderModelsStore,
  loadBuilderModelCatalog,
  reloadBuilderModelCatalog,
} from '~/lib/stores/builder-model.client';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  GATEWAY_PROVIDERS,
  GATEWAY_PROVIDER_SLUGS,
  gatewayModelProvider,
  isBuilderModelId,
  type GatewayProviderSlug,
} from '~/lib/workers-ai-model';
import { errorFeedback, FeedbackLine, noteFeedback, type Feedback } from './Feedback';
import { getJson, messageOf, postJson } from './organization-requests.client';

const providerKeySchema = z.object({
  provider: z.enum(GATEWAY_PROVIDER_SLUGS),
  key: z.object({ alias: z.string(), secretPreview: z.string().nullable(), addedByCloudChef: z.boolean() }).nullable(),
});

const keysSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), providers: z.array(providerKeySchema) }),
  z.object({ status: z.literal('reauthorization_required') }),
  z.object({ status: z.literal('unknown') }),
]);

const settingsSchema = z.object({
  canManage: z.boolean(),
  defaultModelId: z.string().nullable(),
  keys: keysSchema,
});

const keysResponseSchema = z.object({ keys: keysSchema });
const linkResponseSchema = z.object({
  keys: keysSchema,
  authenticationTurnedOn: z.boolean(),
  previousKeysRemain: z.boolean().catch(false),
});
const defaultResponseSchema = z.object({ defaultModelId: z.string().nullable() });

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
 * The models of the Cloudflare account the person builds in: the one everyone starts on, and each AI
 * Gateway provider's, which run with the account's own key for that provider. A team's admins (or
 * the person whose own account it is) change both; everyone can still pick another model in the
 * builder.
 */
export function ModelsCard() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);
  const models = useStore(builderModelsStore);
  const catalogStatus = useStore(builderModelCatalogStatusStore);
  const { data: session } = authClient.useSession();
  const accountLabel = workspaceLabel(session?.context ?? null);

  const refresh = useCallback(async () => {
    setSettings(await getJson(PATH, settingsSchema));
  }, []);

  useEffect(() => {
    refresh().catch((failure) => {
      setFeedback(errorFeedback(messageOf(failure instanceof Error ? failure : null, 'Unable to load models.')));
    });
    void loadBuilderModelCatalog();
  }, [refresh]);

  /** Runs one change and says how it went (a null note says nothing); true when it went through. */
  const act = async (operation: () => Promise<string | null>, { refreshOnFailure = false } = {}): Promise<boolean> => {
    setBusy(true);
    setFeedback(null);
    try {
      const note = await operation();
      setFeedback(note === null ? null : noteFeedback(note));
      return true;
    } catch (failure) {
      setFeedback(errorFeedback(messageOf(failure instanceof Error ? failure : null, 'That did not work. Try again.')));
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
        return `CloudChef’s ${GATEWAY_PROVIDERS[provider].label} key is removed, and deleted from your Secrets Store.`;
      },
      { refreshOnFailure: true },
    );

  const chooseDefault = (value: string) =>
    act(async () => {
      const { defaultModelId } = await postJson(
        `${PATH}/default`,
        { modelId: value === CLOUDCHEF_DEFAULT ? null : value },
        defaultResponseSchema,
      );
      setSettings((current) => (current ? { ...current, defaultModelId } : current));
      // The catalog names the default, and new chats in this browser start on the one it names.
      void reloadBuilderModelCatalog();
      return 'Saved. New chats start on this model; anyone can still switch.';
    });

  // The chosen default may be a model the account no longer offers (its key removed since): still shown.
  const choices = models.some(({ id }) => id === settings?.defaultModelId)
    ? models
    : [
        ...models,
        ...(settings?.defaultModelId ? [{ id: settings.defaultModelId, label: settings.defaultModelId }] : []),
      ];

  return (
    <section
      id="models"
      className="app-card w-full min-w-0 p-4 [overflow-wrap:anywhere]"
      aria-labelledby="models-heading"
    >
      <h2 id="models-heading" className="app-card-title">
        Models
      </h2>
      {accountLabel ? <p className="mt-1 text-sm text-content-secondary">For {accountLabel}.</p> : null}
      {settings === null ? (
        feedback ? (
          <div className="mt-2">
            <Button size="sm" variant="neutral" disabled={busy} onClick={() => void retry()}>
              Retry
            </Button>
          </div>
        ) : (
          <p className="mt-1 text-sm text-content-secondary" role="status">
            Loading…
          </p>
        )
      ) : (
        <>
          <label className="mt-3 block text-sm font-medium text-content-primary" htmlFor="default-model">
            Default model
          </label>
          <p className="mt-1 max-w-2xl text-sm text-content-secondary">
            {settings.canManage
              ? 'Everyone building in this account starts new chats on this model, and can switch in the builder.'
              : 'Chosen by this team’s admins. You can switch models in the builder.'}
          </p>
          <select
            id="default-model"
            className="mt-2 w-full max-w-md rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1.5 text-sm text-content-primary"
            value={settings.defaultModelId ?? CLOUDCHEF_DEFAULT}
            disabled={!settings.canManage || busy}
            onChange={(event) => void chooseDefault(event.target.value)}
          >
            <option value={CLOUDCHEF_DEFAULT}>CloudChef’s default ({CLOUDFLARE_WORKERS_AI_MODEL})</option>
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
          {catalogStatus === 'error' ? (
            <p className="mt-1 text-xs text-content-tertiary">The account’s model list could not be loaded just now.</p>
          ) : catalogStatus === 'stale' ? (
            <p className="mt-1 text-xs text-content-tertiary">
              The account’s model list could not be refreshed just now, so these are the models it last listed.
            </p>
          ) : null}

          <h3 className="mt-5 text-sm font-medium text-content-primary">Provider keys</h3>
          <p className="mt-1 max-w-2xl text-sm text-content-secondary">
            Each provider’s models run through this account’s AI Gateway with the account’s own key for that provider,
            kept in its Cloudflare Secrets Store. A key added in the Cloudflare dashboard, under any alias, is used as
            it is. The provider bills its key; CloudChef never keeps it.
          </p>
          {settings.keys.status === 'ready' ? (
            <ul className="mt-3 grid gap-3">
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
            <p className="mt-2 max-w-2xl text-sm text-content-secondary">
              This account’s admins need to reauthorize Cloudflare before provider keys can be linked.
            </p>
          )}
          {settings.canManage && settings.keys.status === 'ready' ? (
            <p className="mt-3 max-w-2xl text-xs text-content-tertiary">
              Cloudflare keeps AI Gateway keys only on a gateway with authentication on and a Secrets Store linked, so
              linking turns those on for the default gateway if they’re off and keeps its other settings.
            </p>
          ) : null}
        </>
      )}
      <FeedbackLine feedback={feedback} />
    </section>
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
  const { label } = GATEWAY_PROVIDERS[provider];
  const status = key
    ? `Linked${key.secretPreview ? ` (${key.secretPreview})` : ''}, alias ${key.alias}, ${
        key.addedByCloudChef ? 'added in CloudChef' : 'added in Cloudflare'
      }: ${label} models are in the picker.`
    : `Not linked: ${label} models aren’t offered in this account.`;
  return (
    <li className="rounded border border-bolt-elements-borderColor p-3">
      <p className="text-sm font-medium text-content-primary">{label}</p>
      <p className="mt-1 text-sm text-content-secondary">{status}</p>
      {canManage ? (
        <>
          <form
            className="mt-2 flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void onLink(apiKey).then((linked) => {
                // A refused key stays in the field, to correct or try again.
                if (linked) {
                  setApiKey('');
                }
              });
            }}
          >
            <input
              type="password"
              autoComplete="off"
              aria-label={`${label} API key`}
              placeholder={`Paste a ${label} API key`}
              className="min-w-0 grow rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1.5 text-sm text-content-primary"
              value={apiKey}
              disabled={busy}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <Button size="sm" variant="neutral" type="submit" disabled={busy || apiKey.trim().length === 0}>
              {key ? 'Replace' : 'Save to Secrets Store'}
            </Button>
          </form>
          {key && !key.addedByCloudChef ? (
            <p className="mt-1 text-xs text-content-tertiary">
              Saving a key here replaces the one added in Cloudflare (alias {key.alias}) on the gateway.
            </p>
          ) : null}
          {key?.addedByCloudChef ? (
            <div className="mt-2">
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void onUnlink()}>
                Remove {label} key
              </Button>
            </div>
          ) : null}
        </>
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
    <div className="mt-2 grid max-w-2xl justify-items-start gap-2 text-sm text-content-secondary">
      <p>
        {team
          ? `${team.orgName} connected its Cloudflare account before CloudChef could manage AI Gateway keys. Reauthorize it once to give CloudChef that permission.`
          : 'This Cloudflare account was connected before CloudChef could manage AI Gateway keys. Reauthorize it once to give CloudChef that permission.'}
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
