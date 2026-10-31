import { useStore } from '@nanostores/react';
import { useSearch } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEventHandler,
  type KeyboardEventHandler,
} from 'react';
import { getMessageInputRevision, messageInputStore, setMessageInput } from '~/lib/stores/messageInput';
import { takePendingSubmit } from '~/lib/stores/pending-submit';
import { useCloudChefAuthKind } from '~/lib/stores/userId';
import { debounce } from '~/utils/debounce';
import { PENDING_PROMPT_STORAGE_KEY } from '~/utils/constants';
import {
  CLOUDFLARE_AUTHORIZATION_ERROR_PARAM,
  CLOUDFLARE_AUTHORIZATION_ERROR_VALUE,
} from '~/lib/cloudflare/authorization-recovery';

interface MessageInputControllerOptions {
  isStreaming: boolean;
  onStop: () => void;
  onSend: (message: string, onAccepted?: () => void) => Promise<boolean>;
  prefillEnabled?: boolean;
  /** The composer is closed: nothing typed can be sent, though a running turn can still be stopped. */
  disabled?: boolean;
}

export function useMessageInputController({
  isStreaming,
  onStop,
  onSend,
  prefillEnabled = true,
  disabled = false,
}: MessageInputControllerOptions) {
  const authKind = useCloudChefAuthKind();
  const input = useStore(messageInputStore);
  // The store is read through a subscription React starts only after the box first paints. Until then a key that
  // changed only the store re-rendered nothing, and React put the box's old text back over it: typing right as the
  // page loaded lost characters. Each change also sets this state, so the box re-renders with the store's latest
  // text at once, subscribed or not.
  const [, showTyped] = useState('');
  const search = useSearch({ from: '__root__' });

  // What was typed into the home's early box before this editor loaded wins over any prefill. The textarea takes
  // it as it mounts, before this hook's effect runs; the prefill is a layout effect too, so nothing typed into the
  // new box can land before it and be replaced by it.
  const tookEarlyPrompt = useRef(false);
  const takeEarlyPrompt = useCallback((typed: string) => {
    tookEarlyPrompt.current = true;
    setMessageInput(typed);
    showTyped(typed);
    cachePrompt(typed);
  }, []);
  useLayoutEffect(() => {
    if (!prefillEnabled || tookEarlyPrompt.current) {
      return;
    }
    setMessageInput(search.prefill || readPendingPrompt() || '');
  }, [prefillEnabled, search.prefill]);

  const send = useCallback(
    async (prompt = messageInputStore.get()) => {
      const inputRevision = getMessageInputRevision();
      await submitMessageInput(prompt, onSend, () => {
        clearPromptIfUnchanged(prompt, inputRevision);
      });
    },
    [onSend],
  );

  // Signing in, or choosing where to build, opens over the composer; a submit that asked for it may be finished
  // once the person's own Cloudflare account is connected (`continuePrompt`), and nothing else may.
  const [signInRequest, setSignInRequest] = useState<{ continuePrompt?: string } | null>(null);
  const signIn = useCallback(
    ({ continueOnReturn = false }: { continueOnReturn?: boolean } = {}) => {
      preservePromptForAuthentication(input);
      setSignInRequest(continueOnReturn && input.trim() ? { continuePrompt: input } : {});
    },
    [input],
  );
  const closeSignIn = useCallback(() => setSignInRequest(null), []);

  // Decided once per mount, on the first resolved session: the continuation is written just
  // before the browser leaves for Cloudflare, so a later render must never re-read it.
  const continuationDecidedRef = useRef(false);
  useEffect(() => {
    if (authKind === 'loading' || continuationDecidedRef.current) {
      return;
    }
    continuationDecidedRef.current = true;
    const pendingSubmit = takePendingSubmit();
    if (
      pendingSubmit &&
      shouldContinuePendingSubmit({
        authKind,
        pendingSubmit,
        prompt: messageInputStore.get(),
        authorizationFailed: hasFailedCloudflareAuthorization(window.location.search),
      })
    ) {
      void send(pendingSubmit);
    }
  }, [authKind, send]);

  const primaryAction = getMessageInputPrimaryAction({
    authKind,
    isStreaming,
    hasInput: input.trim().length > 0,
    disabled,
  });
  const runPrimaryAction = useCallback(() => {
    switch (primaryAction) {
      case 'stop':
        onStop();
        return;
      case 'sign-in':
        // Started by a submit, so the connection it opens is allowed to finish that submit.
        void signIn({ continueOnReturn: true });
        return;
      case 'send':
        void send();
        return;
      case 'wait':
        return;
    }
  }, [primaryAction, onStop, send, signIn]);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }
      event.preventDefault();
      if (!event.nativeEvent.isComposing) {
        runPrimaryAction();
      }
    },
    [runPrimaryAction],
  );

  const handleChange: ChangeEventHandler<HTMLTextAreaElement> = useCallback((event) => {
    setMessageInput(event.target.value);
    showTyped(event.target.value);
    cachePrompt(event.target.value);
  }, []);

  return {
    authKind,
    handleChange,
    handleKeyDown,
    input,
    primaryAction,
    runPrimaryAction,
    signIn,
    /** What opened sign-in over the composer, or null while it's closed. */
    signInRequest,
    closeSignIn,
    /** Only an unstarted composer that may be prefilled takes what was typed into the home's early box. */
    takeEarlyPrompt: prefillEnabled ? takeEarlyPrompt : undefined,
  };
}

/**
 * A submit that stopped to connect Cloudflare is finished on return, but only when every part
 * of that instruction still holds: the connection succeeded, the person is connected, and the
 * prompt in the composer is still the one they submitted. The intent is spent by reading it,
 * so this can only ever say yes once.
 */
function shouldContinuePendingSubmit({
  authKind,
  pendingSubmit,
  prompt,
  authorizationFailed,
}: {
  authKind: 'unauthenticated' | 'fullyLoggedIn';
  pendingSubmit: string | null;
  prompt: string;
  authorizationFailed: boolean;
}): boolean {
  if (!pendingSubmit || authorizationFailed) {
    return false;
  }
  // Coming back without a session means the authorization failed or was cancelled.
  return authKind === 'fullyLoggedIn' && prompt.trim() === pendingSubmit;
}

function hasFailedCloudflareAuthorization(search: string): boolean {
  return new URLSearchParams(search).get(CLOUDFLARE_AUTHORIZATION_ERROR_PARAM) === CLOUDFLARE_AUTHORIZATION_ERROR_VALUE;
}

type MessageInputPrimaryAction = 'stop' | 'sign-in' | 'send' | 'wait';

/**
 * What the composer's primary button (and Enter) does. While a turn runs, text typed into an open
 * composer is sent as guidance that steers it, and otherwise the button stops the turn: a closed
 * composer can never send, so it only ever stops.
 */
export function getMessageInputPrimaryAction({
  authKind,
  isStreaming,
  hasInput,
  disabled,
}: {
  authKind: 'loading' | 'unauthenticated' | 'fullyLoggedIn';
  isStreaming: boolean;
  hasInput: boolean;
  disabled: boolean;
}): MessageInputPrimaryAction {
  if (isStreaming) {
    return hasInput && !disabled ? 'send' : 'stop';
  }
  if (disabled || authKind === 'loading') {
    return 'wait';
  }
  return authKind === 'unauthenticated' ? 'sign-in' : 'send';
}

export function getMessageInputPrimaryActionLabel(
  action: MessageInputPrimaryAction,
  isStreaming: boolean,
): 'Stop' | 'Sign in' | 'Send' | 'Send guidance' {
  if (action === 'stop') {
    return 'Stop';
  }
  if (action === 'sign-in') {
    return 'Sign in';
  }
  return isStreaming ? 'Send guidance' : 'Send';
}

export function clearPromptIfUnchanged(sourceInput: string, expectedRevision: number): boolean {
  if (expectedRevision !== getMessageInputRevision() || messageInputStore.get() !== sourceInput) {
    return false;
  }
  setMessageInput('');
  cachePrompt.cancel();
  storePendingPrompt('');
  return true;
}

const cachePrompt = debounce(function cachePrompt(prompt: string) {
  storePendingPrompt(prompt.trim());
}, 1000);

export function preservePromptForAuthentication(input: string): void {
  cachePrompt.cancel();
  storePendingPrompt(input.trim());
}

function readPendingPrompt(): string | null {
  try {
    return window.sessionStorage.getItem(PENDING_PROMPT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storePendingPrompt(prompt: string): void {
  try {
    if (prompt) {
      window.sessionStorage.setItem(PENDING_PROMPT_STORAGE_KEY, prompt);
    } else {
      window.sessionStorage.removeItem(PENDING_PROMPT_STORAGE_KEY);
    }
  } catch {
    // Prompt handoff remains best-effort when browser storage is unavailable.
  }
}

export async function submitMessageInput(
  input: string,
  onSend: (message: string, onAccepted?: () => void) => Promise<boolean>,
  onAccepted: () => void,
): Promise<boolean> {
  const message = input.trim();
  if (!message) {
    return false;
  }
  return onSend(message, onAccepted);
}
