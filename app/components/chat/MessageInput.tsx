import {
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type ChangeEventHandler,
  type KeyboardEventHandler,
} from 'react';
import { ArrowRightIcon, StopIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { KeyboardShortcut } from '@ui/KeyboardShortcut';
import { Spinner } from '@ui/Spinner';
import { CloudflareConnectLegalNotice } from '~/components/CloudflareConnectLegalNotice';
import { SessionCheckError } from '~/components/CloudflareSignInPrompt';
import { authClient } from '~/lib/auth-client';
import { LinkButton } from '~/components/ui/LinkButton';
import { classNames } from '~/utils/classNames';
import { MAX_USER_MESSAGE_CHARACTERS } from 'cloudchef-agent/context-limits';
import { getMessageInputPrimaryActionLabel, useMessageInputController } from './useMessageInputController';
import { BuilderModelSelector } from './BuilderModelSelector.client';
import { NewModelsNotice } from './NewModelsNotice.client';
import { PromptPrefillContext } from './prompt-prefill';

interface MessageInputProps {
  chatStarted: boolean;
  isStreaming: boolean;
  sendMessageInProgress: boolean;
  onStop: () => void;
  onSend: (message: string, onAccepted?: () => void) => Promise<boolean>;
  disabled: boolean;
  /** Whether a started chat has messages yet, which its placeholder follows. */
  hasMessages: boolean;
  /** What an empty, unstarted composer asks for, when the project already says what it is. */
  placeholder?: string;
}

export const MessageInput = memo(function MessageInput({
  chatStarted,
  isStreaming,
  sendMessageInProgress,
  onStop,
  onSend,
  disabled,
  hasMessages,
  placeholder: unstartedPlaceholder = 'Describe your app…',
}: MessageInputProps) {
  const prefillAllowed = useContext(PromptPrefillContext);
  const controller = useMessageInputController({
    isStreaming,
    onStop,
    onSend,
    prefillEnabled: !chatStarted && prefillAllowed,
    disabled,
  });
  const { authKind, input, primaryAction } = controller;
  const { data: session, error: sessionError } = authClient.useSession();
  const primaryActionLabel = getMessageInputPrimaryActionLabel(primaryAction, isStreaming);
  const hasActiveSession = authKind === 'fullyLoggedIn';
  // The opening turn writes most of the application, so the model is chosen before it, not only once a chat
  // exists; a signed-out visitor has no model to run.
  const modelSelector = hasActiveSession && (
    <BuilderModelSelector disabled={disabled || isStreaming || sendMessageInProgress} />
  );
  const placeholder = chatStarted
    ? isStreaming
      ? 'Add guidance while CloudChef works…'
      : hasMessages
        ? 'What would you like to do next?'
        : 'Start this chat with a prompt…'
    : unstartedPlaceholder;
  const inputStatus = input.length > 3 ? <NewLineShortcut /> : null;
  const actions = (
    <>
      {chatStarted && authKind === 'unauthenticated' && (
        <Button variant="neutral" onClick={() => void controller.signIn()} size="xs" className="text-xs font-normal">
          <span>Connect Cloudflare</span>
        </Button>
      )}
      <Button
        // A closed composer still stops a running turn: only sending waits for it to open.
        disabled={
          (!isStreaming && (input.trim().length === 0 || disabled)) || authKind === 'loading' || sendMessageInProgress
        }
        tip={authKind === 'unauthenticated' ? 'Connect Cloudflare to continue' : undefined}
        onClick={controller.runPrimaryAction}
        size="xs"
        className={classNames('ml-1 h-8 min-w-8 rounded', !chatStarted ? 'cloudchef-message-input__send' : '')}
        aria-label={primaryActionLabel}
        // The icon follows the action: guidance typed while a turn runs is sent, not a stop.
        icon={
          sendMessageInProgress ? (
            <Spinner className="text-white" />
          ) : primaryAction === 'stop' ? (
            <StopIcon />
          ) : (
            <ArrowRightIcon />
          )
        }
      />
    </>
  );

  return (
    <>
      <div
        className={classNames(
          'relative z-20 mx-auto w-full transition-all',
          chatStarted ? 'max-w-none' : 'cloudchef-message-input--home max-w-none',
        )}
      >
        {modelSelector ? <NewModelsNotice /> : null}
        <div
          className={classNames(
            'cloudchef-message-input__surface rounded-lg bg-bolt-elements-background-depth-1 shadow-panel',
            !chatStarted ? 'p-2' : '',
          )}
        >
          <div
            className={classNames(
              'cloudchef-message-input__editor relative border border-bolt-elements-borderColor transition-all has-[textarea:focus]:border-border-selected',
            )}
          >
            <PromptTextarea
              onKeyDown={controller.handleKeyDown}
              onChange={controller.handleChange}
              value={input}
              minHeight={44}
              maxHeight={chatStarted ? 200 : 160}
              placeholder={placeholder}
              disabled={disabled}
            />
            <div className="flex items-center gap-2 px-2 pb-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {modelSelector}
                <div className="hidden min-w-0 sm:block">{inputStatus}</div>
              </div>
              <div className="ml-auto flex items-center gap-1">{actions}</div>
            </div>
          </div>
        </div>
      </div>
      {authKind === 'unauthenticated' && !session && sessionError ? (
        <SessionCheckError className="mt-4 text-center" />
      ) : authKind === 'unauthenticated' ? (
        <>
          <CloudflareConnectLegalNotice className="mx-auto mt-2 w-full px-1" />
          {/* Describing an app connects you on the way; this signs in without one. */}
          <div className="mt-4 flex justify-center">
            <LinkButton to="/sign-in" variant="neutral" size="sm">
              {session ? 'Connect Cloudflare' : 'Sign in or connect Cloudflare'}
            </LinkButton>
          </div>
        </>
      ) : null}
    </>
  );
});

function PromptTextarea({
  onKeyDown,
  onChange,
  value,
  minHeight,
  maxHeight,
  placeholder,
  disabled,
}: {
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onChange: ChangeEventHandler<HTMLTextAreaElement>;
  value: string;
  minHeight: number;
  maxHeight: number;
  placeholder: string;
  disabled: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // The textarea grows with its text, so only the box around it ever scrolls, and only once the text is
  // taller than the box: an empty composer never shows a scrollbar.
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = `${ref.current.scrollHeight}px`;
      setOverflowing(ref.current.scrollHeight > maxHeight);
    }
  }, [value, maxHeight]);

  return (
    <div
      className={classNames(
        'relative',
        overflowing
          ? 'overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-macosScrollbar-thumb'
          : 'overflow-y-hidden',
      )}
      style={{ minHeight, maxHeight }}
    >
      <textarea
        ref={ref}
        rows={1}
        className={classNames(
          'block w-full appearance-none resize-none overflow-hidden bg-transparent text-sm leading-snug text-content-primary outline-hidden placeholder-content-tertiary p-3',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onChange={onChange}
        value={value}
        style={{ minHeight }}
        placeholder={placeholder}
        aria-label="Message to CloudChef"
        translate="no"
        data-gramm="false"
        maxLength={MAX_USER_MESSAGE_CHARACTERS}
      />
    </div>
  );
}

function NewLineShortcut() {
  return (
    <div className="text-xs text-content-tertiary">
      <KeyboardShortcut value={['Shift', 'Return']} className="mr-0.5 font-semibold" /> for new line
    </div>
  );
}
