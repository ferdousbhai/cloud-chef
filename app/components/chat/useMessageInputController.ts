import { useStore } from '@nanostores/react';
import { useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState, type ChangeEventHandler, type KeyboardEventHandler } from 'react';
import { toast } from 'sonner';
import { WORKERS_PAID_REQUIRED_MARKER } from '~/lib/workers-paid';
import { showWorkersPaidRequiredToast } from '~/lib/workers-paid.client';
import { captureException } from '~/lib/telemetry.client';
import { fetchUserRuntime } from '~/lib/cloudflare/runtime-session';
import { createCloudflareReturnURL, signInWithCloudflare } from '~/lib/auth-client';
import { getMessageInputRevision, messageInputStore, setMessageInput } from '~/lib/stores/messageInput';
import { takePendingSubmit } from '~/lib/stores/pending-submit';
import { isAuthenticated, useCloudChefAuthKind } from '~/lib/stores/userId';
import { debounce } from '~/utils/debounce';
import { PENDING_PROMPT_STORAGE_KEY } from '~/utils/constants';
import {
  CLOUDFLARE_AUTHORIZATION_ERROR_PARAM,
  CLOUDFLARE_AUTHORIZATION_ERROR_VALUE,
} from '~/lib/cloudflare/authorization-recovery';
import {
  promptRefinementResultSchema,
  type PromptRefinementAnswer,
  type PromptRefinementQuestion,
} from '~/lib/prompt-refinement';
import { z } from 'zod';
import { messageOf } from '~/lib/json-request';

/** Failure envelope returned by the prompt-enhancement endpoint. */
const enhanceFailureSchema = z.looseObject({
  code: z.literal('workers_paid_required').optional().catch(undefined),
  error: z.string().optional().catch(undefined),
});

interface MessageInputControllerOptions {
  isStreaming: boolean;
  onStop: () => void;
  onSend: (message: string, onAccepted?: () => void) => Promise<boolean>;
  prefillEnabled?: boolean;
  /** The composer is closed: nothing typed can be sent, though a running turn can still be stopped. */
  disabled?: boolean;
}

interface PromptRefinementSession {
  sourceInput: string;
  sourceRevision: number;
  answers: PromptRefinementAnswer[];
  questions: PromptRefinementQuestion[];
}

export function useMessageInputController({
  isStreaming,
  onStop,
  onSend,
  prefillEnabled = true,
  disabled = false,
}: MessageInputControllerOptions) {
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [refinement, setRefinement] = useState<PromptRefinementSession | null>(null);
  const enhanceRequestRef = useRef<AbortController | null>(null);
  const authKind = useCloudChefAuthKind();
  const input = useStore(messageInputStore);
  const search = useSearch({ from: '__root__' });

  useEffect(() => {
    if (!prefillEnabled) {
      return;
    }

    setMessageInput(search.prefill || readPendingPrompt() || '');
  }, [prefillEnabled, search.prefill]);

  useEffect(
    () => () => {
      enhanceRequestRef.current?.abort();
    },
    [],
  );

  const send = useCallback(
    async (prompt = messageInputStore.get()) => {
      const inputRevision = getMessageInputRevision();
      await submitMessageInput(prompt, onSend, () => {
        clearPromptIfUnchanged(prompt, inputRevision);
      });
    },
    [onSend],
  );

  const signIn = useCallback(
    async ({ continueOnReturn = false }: { continueOnReturn?: boolean } = {}) => {
      preservePromptForAuthentication(input);
      try {
        await signInWithCloudflare(
          createCloudflareReturnURL(),
          continueOnReturn ? { continuePrompt: input } : undefined,
        );
      } catch (error) {
        captureException('Failed to start Cloudflare authorization', error, { level: 'error' });
        toast.error(messageOf(error, 'Unable to connect Cloudflare. Please try again.'));
      }
    },
    [input],
  );

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
    cachePrompt(event.target.value);
  }, []);

  const requestPromptRefinement = useCallback(
    async (
      sourceInput: string,
      sourceRevision: number,
      answers: PromptRefinementAnswer[],
      controller: AbortController,
    ) => {
      const response = await fetchUserRuntime('/v1/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: sourceInput.trim(), answers }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = enhanceFailureSchema.safeParse(await response.json().catch(() => null)).data;
        if (payload?.code === 'workers_paid_required' || payload?.error?.includes(WORKERS_PAID_REQUIRED_MARKER)) {
          showWorkersPaidRequiredToast();
          return;
        }
        throw new Error(payload?.error || 'Failed to refine the build plan. Please try again.');
      }
      const result = promptRefinementResultSchema.safeParse(await response.json());
      if (!result.success) {
        throw new Error('CloudChef returned an invalid plan refinement response.');
      }
      if (controller.signal.aborted) {
        return;
      }
      if (result.data.kind === 'complete') {
        setRefinement(null);
        replacePromptIfUnchanged(sourceInput, sourceRevision, result.data.enhancedPrompt);
        return;
      }
      if (!isPromptUnchanged(sourceInput, sourceRevision)) {
        return;
      }
      setRefinement({ sourceInput, sourceRevision, answers, questions: result.data.questions });
    },
    [],
  );

  /** Runs one refinement request in place of any still in flight; one replaced or cancelled ends quietly. */
  const runRefinementRequest = useCallback(async (request: (controller: AbortController) => Promise<void>) => {
    enhanceRequestRef.current?.abort();
    const controller = new AbortController();
    enhanceRequestRef.current = controller;
    try {
      setIsEnhancing(true);
      await request(controller);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      captureException('Failed to enhance prompt', error, { level: 'error' });
      toast.error(messageOf(error, 'Failed to refine the build plan. Please try again.'));
    } finally {
      if (enhanceRequestRef.current === controller) {
        enhanceRequestRef.current = null;
        setIsEnhancing(false);
      }
    }
  }, []);

  const enhancePrompt = useCallback(() => {
    const sourceInput = messageInputStore.get();
    const sourceRevision = getMessageInputRevision();
    return runRefinementRequest(async (controller) => {
      if (!isAuthenticated()) {
        throw new Error('Not authenticated');
      }
      setRefinement(null);
      await requestPromptRefinement(sourceInput, sourceRevision, [], controller);
    });
  }, [requestPromptRefinement, runRefinementRequest]);

  const answerRefinementQuestions = useCallback(
    async (roundAnswers: PromptRefinementAnswer[]) => {
      if (!refinement || isEnhancing) {
        return;
      }
      const answers = [...refinement.answers, ...roundAnswers];
      await runRefinementRequest((controller) =>
        requestPromptRefinement(refinement.sourceInput, refinement.sourceRevision, answers, controller),
      );
    },
    [isEnhancing, refinement, requestPromptRefinement, runRefinementRequest],
  );

  const cancelRefinement = useCallback(() => {
    const controller = enhanceRequestRef.current;
    enhanceRequestRef.current = null;
    controller?.abort();
    setIsEnhancing(false);
    setRefinement(null);
  }, []);

  return {
    answerRefinementQuestions,
    authKind,
    cancelRefinement,
    enhancePrompt,
    handleChange,
    handleKeyDown,
    input,
    isEnhancing,
    primaryAction,
    refinement,
    runPrimaryAction,
    signIn,
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
): 'Stop' | 'Connect Cloudflare' | 'Send' | 'Send guidance' {
  if (action === 'stop') {
    return 'Stop';
  }
  if (action === 'sign-in') {
    return 'Connect Cloudflare';
  }
  return isStreaming ? 'Send guidance' : 'Send';
}

function isPromptUnchanged(sourceInput: string, expectedRevision: number): boolean {
  return expectedRevision === getMessageInputRevision() && messageInputStore.get() === sourceInput;
}

export function replacePromptIfUnchanged(
  sourceInput: string,
  expectedRevision: number,
  enhancedPrompt: string,
): boolean {
  if (!isPromptUnchanged(sourceInput, expectedRevision)) {
    return false;
  }
  setMessageInput(enhancedPrompt);
  return true;
}

export function clearPromptIfUnchanged(sourceInput: string, expectedRevision: number): boolean {
  if (!replacePromptIfUnchanged(sourceInput, expectedRevision, '')) {
    return false;
  }
  cachePrompt.cancel();
  storePendingPrompt('');
  return true;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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
