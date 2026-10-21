import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { Button } from '~/components/ui/primitives/Button';
import {
  builderModelCatalogStatusStore,
  builderModelsStore,
  loadBuilderModelCatalog,
} from '~/lib/stores/builder-model.client';
import { CLOUDFLARE_WORKERS_AI_MODEL, isBuilderModelId, isClaudeModelId } from '~/lib/workers-ai-model';
import { errorFeedback, FeedbackLine, noteFeedback, type Feedback } from './Feedback';
import { getJson, messageOf, postJson } from './organization-requests.client';

const claudeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('linked'), alias: z.string(), secretPreview: z.string().nullable() }),
  z.object({ status: z.literal('unlinked') }),
  z.object({ status: z.literal('reauthorization_required') }),
  z.object({ status: z.literal('unknown') }),
]);

const settingsSchema = z.object({
  canManage: z.boolean(),
  defaultModelId: z.string().nullable(),
  claude: claudeSchema,
});

const claudeResponseSchema = z.object({ claude: claudeSchema });
const linkResponseSchema = z.object({ claude: claudeSchema, authenticationTurnedOn: z.boolean() });

const AUTHENTICATION_TURNED_ON_NOTE =
  'Authentication is now on for this account’s default AI Gateway. CloudChef is unaffected; your own apps calling this gateway over HTTP now need a gateway token.';
const defaultResponseSchema = z.object({ defaultModelId: z.string().nullable() });

type Settings = z.infer<typeof settingsSchema>;

const PATH = '/api/settings/models';
/** The select's value for "no choice": CloudChef's own default. */
const CLOUDCHEF_DEFAULT = '';

/**
 * The models of the Cloudflare account the person builds in: the one everyone starts on, and Claude,
 * which runs with the account's own Anthropic key. A team's admins (or the person whose own account
 * it is) change both; everyone can still pick another model in the builder.
 */
export function ModelsCard() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const models = useStore(builderModelsStore);
  const catalogStatus = useStore(builderModelCatalogStatusStore);

  const refresh = useCallback(async () => {
    setSettings(await getJson(PATH, settingsSchema));
  }, []);

  useEffect(() => {
    refresh().catch((failure) => {
      setFeedback(errorFeedback(messageOf(failure instanceof Error ? failure : null, 'Unable to load models.')));
    });
    void loadBuilderModelCatalog();
  }, [refresh]);

  const act = async (operation: () => Promise<string>) => {
    setBusy(true);
    setFeedback(null);
    try {
      setFeedback(noteFeedback(await operation()));
    } catch (failure) {
      setFeedback(errorFeedback(messageOf(failure instanceof Error ? failure : null, 'That did not work. Try again.')));
    } finally {
      setBusy(false);
    }
  };

  const link = () =>
    act(async () => {
      const { claude, authenticationTurnedOn } = await postJson(`${PATH}/claude/link`, { apiKey }, linkResponseSchema);
      setApiKey('');
      setSettings((current) => (current ? { ...current, claude } : current));
      void loadBuilderModelCatalog();
      const linked = 'Claude is linked. It appears in the model picker within a minute.';
      return authenticationTurnedOn ? `${linked} ${AUTHENTICATION_TURNED_ON_NOTE}` : linked;
    });

  const unlink = () =>
    act(async () => {
      const { claude } = await postJson(`${PATH}/claude/unlink`, {}, claudeResponseSchema);
      setSettings((current) => (current ? { ...current, claude } : current));
      return 'Claude is unlinked, and the key is deleted from your Secrets Store.';
    });

  const chooseDefault = (value: string) =>
    act(async () => {
      const { defaultModelId } = await postJson(
        `${PATH}/default`,
        { modelId: value === CLOUDCHEF_DEFAULT ? null : value },
        defaultResponseSchema,
      );
      setSettings((current) => (current ? { ...current, defaultModelId } : current));
      return 'Saved. New chats start on this model; anyone can still switch.';
    });

  // The chosen default may be a model the account no longer offers (Claude unlinked since): still shown.
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
      {settings === null ? (
        <p className="mt-1 text-sm text-content-secondary" role="status">
          {feedback ? null : 'Loading…'}
        </p>
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
            {choices.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
                {isBuilderModelId(model.id) && isClaudeModelId(model.id) ? ' (Claude)' : ''}
              </option>
            ))}
          </select>
          {catalogStatus === 'error' ? (
            <p className="mt-1 text-xs text-content-tertiary">The account’s model list could not be loaded just now.</p>
          ) : null}

          <h3 className="mt-5 text-sm font-medium text-content-primary">Claude</h3>
          <p className="mt-1 max-w-2xl text-sm text-content-secondary">
            Claude runs through this account’s AI Gateway with the account’s own Anthropic key. Cloudflare stores the
            key you paste in the account’s own Secrets Store; Anthropic bills it, and CloudChef never keeps it.
          </p>
          <ClaudeStatusLine claude={settings.claude} />
          {settings.canManage && settings.claude.status !== 'reauthorization_required' ? (
            <div className="mt-3 grid gap-3">
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void link();
                }}
              >
                <input
                  type="password"
                  autoComplete="off"
                  aria-label="Anthropic API key"
                  placeholder="Paste an Anthropic API key"
                  className="min-w-0 grow rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1.5 text-sm text-content-primary"
                  value={apiKey}
                  disabled={busy}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <Button size="sm" variant="neutral" type="submit" disabled={busy || apiKey.trim().length === 0}>
                  Save to Secrets Store
                </Button>
              </form>
              <p className="text-xs text-content-tertiary">
                Cloudflare keeps AI Gateway keys only on a gateway with authentication on and a Secrets Store linked, so
                linking turns those on for the default gateway if they’re off and keeps its other settings.
              </p>
              {settings.claude.status === 'linked' ? (
                <div>
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => void unlink()}>
                    Unlink Claude
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {settings.claude.status === 'reauthorization_required' ? (
            <p className="mt-2 max-w-2xl text-sm text-content-secondary">
              {settings.canManage
                ? 'This account was connected before CloudChef could link keys to its AI Gateway. Reauthorize Cloudflare (above, or under Teams for a team’s account), then come back here.'
                : 'This account’s admins need to reauthorize Cloudflare before Claude can be linked.'}
            </p>
          ) : null}
        </>
      )}
      <FeedbackLine feedback={feedback} />
    </section>
  );
}

function ClaudeStatusLine({ claude }: { claude: Settings['claude'] }) {
  const text =
    claude.status === 'linked'
      ? `Linked${claude.secretPreview ? ` (${claude.secretPreview})` : ''}: Claude models are in the picker.`
      : claude.status === 'unlinked'
        ? 'Not linked: Claude models aren’t offered in this account.'
        : claude.status === 'unknown'
          ? 'Cloudflare couldn’t be asked just now whether a key is linked.'
          : null;
  return text ? <p className="mt-2 text-sm text-content-primary">{text}</p> : null;
}
