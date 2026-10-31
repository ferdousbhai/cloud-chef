import { useEffect, useState, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { Button } from '@ui/Button';
import { BrandLink } from '~/components/BrandLink';
import { SignInPrompt } from '~/components/SignInPrompt';
import { Loading } from '~/components/Loading';
import { authClient } from '~/lib/auth-client';
import { getJson, messageOf, postJson } from '~/lib/json-request';
import { createPrivatePageHead } from '~/lib/social-meta';

const searchSchema = z.object({ code: z.string().max(20).optional().catch(undefined) });
const describedSchema = z.object({ label: z.string() });

/**
 * Where `cloudchef auth login` sends the person: they check the code it shows and let it in, and it gets a
 * command-line token of theirs, which they can remove in Settings.
 */
export const Route = createFileRoute('/login/device')({
  validateSearch: searchSchema,
  head: () => createPrivatePageHead('Sign in the command line | CloudChef', 'Let the cloudchef command line in.'),
  component: DeviceLogin,
});

function DeviceLogin() {
  const { data: session, isPending } = authClient.useSession();
  const { code } = Route.useSearch();
  if (isPending) {
    return <Loading message="Checking your session…" />;
  }
  if (!session) {
    return (
      <SignInPrompt
        title="Sign in to let the command line in."
        returnTo={`/login/device${code ? `?code=${encodeURIComponent(code)}` : ''}`}
      />
    );
  }
  return <Approve initialCode={code ?? ''} />;
}

function Approve({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [label, setLabel] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'approved'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!initialCode) {
      return undefined;
    }
    let canceled = false;
    getJson(`/api/command-line/login/describe?code=${encodeURIComponent(initialCode)}`, describedSchema)
      .then((described) => {
        if (!canceled) {
          setLabel(described.label);
        }
      })
      .catch((failure) => {
        if (!canceled) {
          setError(messageOf(failure, 'That code could not be checked.'));
        }
      });
    return () => {
      canceled = true;
    };
  }, [initialCode]);

  const approve = async (event: FormEvent) => {
    event.preventDefault();
    setState('busy');
    setError(null);
    try {
      await postJson(
        '/api/command-line/login/approve',
        { userCode: code.trim() },
        z.object({ approved: z.literal(true) }),
      );
      setState('approved');
    } catch (failure) {
      setError(messageOf(failure, 'The command line could not be let in. Try again.'));
      setState('idle');
    }
  };

  return (
    <div className="app-page-shell flex min-h-svh items-center px-4 py-6">
      <section className="app-card mx-auto grid w-full max-w-md gap-4 p-6" aria-labelledby="device-login-heading">
        <BrandLink />
        {state === 'approved' ? (
          <>
            <h1 id="device-login-heading" className="font-display text-2xl font-bold text-content-primary">
              The command line is signed in.
            </h1>
            <p className="text-sm text-content-secondary">
              You can close this tab and go back to your terminal. To sign it out later, remove its token in Settings,
              under Command line.
            </p>
          </>
        ) : (
          <form className="grid gap-4" onSubmit={(event) => void approve(event)}>
            <h1 id="device-login-heading" className="font-display text-2xl font-bold text-content-primary">
              Sign in the command line?
            </h1>
            <p className="text-sm text-content-secondary">
              {label ? (
                <>
                  <span className="text-content-primary">{label}</span> asks to work on your projects as you: clone and
                  push them, publish them, and read how publishing went.
                </>
              ) : (
                'Enter the code your terminal shows to let the cloudchef command line work on your projects as you.'
              )}
            </p>
            <label className="grid gap-1 text-sm text-content-secondary">
              Code from your terminal
              <input
                className="rounded-md border border-bolt-elements-borderColor bg-transparent px-3 py-2 font-mono text-lg tracking-widest text-content-primary"
                value={code}
                maxLength={20}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
            <p className="text-xs text-content-tertiary">
              Only continue if you just ran cloudchef auth login and the code matches.
            </p>
            {error ? (
              <p className="text-sm text-content-error" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" variant="primary" loading={state === 'busy'} disabled={code.trim() === ''}>
              Sign in the command line
            </Button>
          </form>
        )}
      </section>
    </div>
  );
}
