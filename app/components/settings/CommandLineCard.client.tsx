import { useEffect, useState, type FormEvent } from 'react';
import { format } from 'date-fns';
import { CheckIcon, CopyIcon } from '@radix-ui/react-icons';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { errorFeedback, FeedbackLine, type Feedback } from './Feedback';
import { SettingsCard } from './SettingsLayout';
import { getJson, messageOf, postJson } from '~/lib/json-request';

const TOKENS_PATH = '/api/settings/command-line-tokens';

const tokenSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  expiresAt: z.number(),
});
const tokensSchema = z.object({ tokens: z.array(tokenSchema) });
const createdSchema = z.object({ token: z.string(), record: tokenSchema });

type CommandLineToken = z.infer<typeof tokenSchema>;

/**
 * Personal tokens for working on projects from the person's own computer, with their own tools (Claude Code
 * included): git clones and pushes a project through CloudChef, and a push to main publishes it. A new token is
 * shown once; only its name and dates are kept to show here.
 */
export function CommandLineCard() {
  const [tokens, setTokens] = useState<CommandLineToken[] | null>(null);
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    let canceled = false;
    getJson(TOKENS_PATH, tokensSchema)
      .then((loaded) => {
        if (!canceled) {
          setTokens(loaded.tokens);
        }
      })
      .catch((failure) => {
        if (!canceled) {
          setFeedback(errorFeedback(messageOf(failure, 'Your tokens could not be loaded.')));
        }
      });
    return () => {
      canceled = true;
    };
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const made = await postJson(`${TOKENS_PATH}/create`, { label: label.trim() }, createdSchema);
      setCreated(made.token);
      setCopied(false);
      setLabel('');
      setTokens((current) => [made.record, ...(current ?? [])]);
    } catch (failure) {
      setFeedback(errorFeedback(messageOf(failure, 'The token could not be made. Try again.')));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: CommandLineToken) => {
    setBusy(true);
    setFeedback(null);
    try {
      await postJson(`${TOKENS_PATH}/revoke`, { id: token.id }, z.object({ revoked: z.literal(true) }));
      setTokens((current) => (current ?? []).filter((item) => item.id !== token.id));
    } catch (failure) {
      setFeedback(errorFeedback(messageOf(failure, 'The token could not be removed. Try again.')));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) {
      return;
    }
    try {
      await navigator.clipboard.writeText(created);
      setCopied(true);
    } catch {
      setFeedback(errorFeedback('The token could not be copied. Select it and copy it instead.'));
    }
  };

  return (
    <SettingsCard
      id="command-line"
      title="Command line"
      description="Work on your projects from your own computer, with your own tools such as Claude Code. Pushing main publishes, just like from the workspace."
    >
      <ol className="mt-3 grid list-decimal gap-1.5 pl-5 text-sm text-content-secondary">
        <li>
          Install it: <code className="font-mono text-xs">curl -fsSL https://cloudchef.build/install.sh | bash</code>
        </li>
        <li>
          Sign in: <code className="font-mono text-xs">cloudchef auth login</code>
        </li>
        <li>
          See your projects and get one: <code className="font-mono text-xs">cloudchef repo list</code>,{' '}
          <code className="font-mono text-xs">cloudchef repo clone &lt;project&gt;</code>. Pushing main publishes;{' '}
          <code className="font-mono text-xs">cloudchef run watch</code> follows it.
        </li>
      </ol>
      <p className="mt-3 text-xs text-content-tertiary">
        Each sign-in makes a token, listed below. For scripts or CI, make one here and use it as the git password or set
        it as CLOUDCHEF_TOKEN.
      </p>

      {created !== null ? (
        <div className="mt-3 grid gap-2 rounded-md border border-bolt-elements-borderColor p-3 text-sm" role="status">
          <p className="text-content-primary">Copy your token now. It won&apos;t be shown again.</p>
          <div className="flex min-w-0 items-start gap-2">
            <code
              className="min-w-0 flex-1 select-all rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-2 font-mono text-xs text-content-primary [overflow-wrap:anywhere]"
              aria-label="New token"
            >
              {created}
            </code>
            <Button
              size="xs"
              variant="neutral"
              icon={copied ? <CheckIcon /> : <CopyIcon />}
              onClick={() => void copy()}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <Button className="justify-self-start" size="xs" variant="neutral" onClick={() => setCreated(null)}>
            Done
          </Button>
        </div>
      ) : (
        <form className="mt-3 flex min-w-0 flex-wrap items-center gap-2" onSubmit={(event) => void create(event)}>
          <input
            className="min-w-0 flex-1 rounded-md border border-bolt-elements-borderColor bg-transparent px-2.5 py-1.5 text-sm text-content-primary"
            value={label}
            maxLength={60}
            placeholder="Name it, such as Work laptop"
            aria-label="Token name"
            onChange={(event) => setLabel(event.target.value)}
          />
          <Button type="submit" size="sm" variant="primary" loading={busy} disabled={label.trim() === ''}>
            Make a token
          </Button>
        </form>
      )}

      {tokens && tokens.length > 0 ? (
        <ul className="mt-3 grid gap-2" aria-label="Your tokens">
          {tokens.map((token) => (
            <li
              key={token.id}
              className="flex min-w-0 items-center gap-3 rounded-md border border-bolt-elements-borderColor px-3 py-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-content-primary">{token.label}</p>
                <p className="text-xs text-content-tertiary">
                  Made {format(token.createdAt, 'PP')} ·{' '}
                  {token.lastUsedAt ? `last used ${format(token.lastUsedAt, 'PP')}` : 'not used yet'} · works until{' '}
                  {format(token.expiresAt, 'PP')}
                </p>
              </div>
              <Button size="xs" variant="neutral" disabled={busy} onClick={() => void revoke(token)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <FeedbackLine feedback={feedback} />
    </SettingsCard>
  );
}
