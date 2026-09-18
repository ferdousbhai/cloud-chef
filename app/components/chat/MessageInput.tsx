import { memo, useEffect, useRef, type ChangeEventHandler, type KeyboardEventHandler } from 'react';
import { ArrowRightIcon, StopIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { KeyboardShortcut } from '@ui/KeyboardShortcut';
import { Spinner } from '@ui/Spinner';
import { CloudflareConnectLegalNotice } from '~/components/CloudflareConnectLegalNotice';
import { classNames } from '~/utils/classNames';
import { MAX_USER_MESSAGE_CHARACTERS } from 'cloudchef-agent/context-limits';
import { EnhancePromptButton } from './EnhancePromptButton.client';
import {
  getMessageInputPrimaryActionLabel,
  shouldOfferBuilderModelSelector,
  useMessageInputController,
} from './useMessageInputController';
import { BuilderModelSelector } from './BuilderModelSelector.client';
import { NewModelsNotice } from './NewModelsNotice.client';
import { PromptRefinementDialog } from './PromptRefinementDialog.client';
import { HOME_COMPOSER_TITLE } from '~/lib/trust';

interface MessageInputProps {
  chatStarted: boolean;
  isStreaming: boolean;
  sendMessageInProgress: boolean;
  onStop: () => void;
  onSend: (message: string, onAccepted?: () => void) => Promise<boolean>;
  disabled: boolean;
  numMessages: number | undefined;
}

export const MessageInput = memo(function MessageInput({
  chatStarted,
  isStreaming,
  sendMessageInProgress,
  onStop,
  onSend,
  disabled,
  numMessages,
}: MessageInputProps) {
  const controller = useMessageInputController({ isStreaming, onStop, onSend, prefillEnabled: !chatStarted });
  const { authState, input } = controller;
  const primaryActionLabel = getMessageInputPrimaryActionLabel(authState.kind, isStreaming, input.trim().length > 0);
  const hasActiveSession = authState.kind === 'fullyLoggedIn';
  const modelSelector = shouldOfferBuilderModelSelector(authState.kind) && (
    <BuilderModelSelector disabled={disabled || isStreaming || sendMessageInProgress} />
  );
  const placeholder = chatStarted
    ? isStreaming
      ? 'Add guidance while CloudChef works…'
      : numMessages !== undefined && numMessages > 0
        ? 'What would you like to do next?'
        : 'Start this chat with a prompt…'
    : 'Describe the app, workflow, and data you want to build…';
  const inputStatus = input.length > 3 ? <NewLineShortcut /> : null;
  const actions = (
    <>
      {chatStarted && authState.kind === 'unauthenticated' && (
        <Button variant="neutral" onClick={() => void controller.signIn()} size="xs" className="text-xs font-normal">
          <span>Connect Cloudflare</span>
        </Button>
      )}
      {hasActiveSession && (
        <EnhancePromptButton
          isEnhancing={controller.isEnhancing}
          disabled={disabled || isStreaming || sendMessageInProgress || input.trim().length === 0}
          onClick={controller.enhancePrompt}
        />
      )}
      <Button
        disabled={
          (!isStreaming && input.trim().length === 0) ||
          authState.kind === 'loading' ||
          sendMessageInProgress ||
          disabled
        }
        tip={authState.kind === 'unauthenticated' ? 'Connect Cloudflare to continue' : undefined}
        onClick={controller.handleButtonClick}
        size="xs"
        className={classNames('ml-1 h-8 min-w-8 rounded', !chatStarted ? 'cloudchef-message-input__send' : '')}
        aria-label={primaryActionLabel}
        icon={
          sendMessageInProgress ? (
            <Spinner className="text-white" />
          ) : primaryActionLabel === 'Send' ? (
            <ArrowRightIcon />
          ) : (
            <StopIcon />
          )
        }
      />
    </>
  );

  return (
    <>
      <div
        className={classNames(
          'relative z-20 mx-auto w-full transition-all duration-200',
          chatStarted ? 'max-w-chat' : 'cloudchef-message-input--home max-w-none',
        )}
      >
        {!chatStarted && (
          <p className="cloudchef-message-input__titlebar" aria-hidden="true">
            {HOME_COMPOSER_TITLE}
          </p>
        )}
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
              minHeight={chatStarted ? 72 : 44}
              maxHeight={chatStarted ? 200 : 160}
              placeholder={placeholder}
              disabled={disabled}
              contentClassName={chatStarted ? 'pb-14' : undefined}
            />
            {chatStarted && (
              <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex items-end gap-2">
                <div className="pointer-events-auto flex min-w-0 flex-1 items-center gap-2 pl-1">
                  {modelSelector}
                  <div className="hidden min-w-0 sm:block">{inputStatus}</div>
                </div>
                <div className="pointer-events-auto ml-auto flex items-center gap-1">{actions}</div>
              </div>
            )}
          </div>
          {!chatStarted && (
            <div className="cloudchef-message-input__footer flex flex-wrap items-center gap-2 rounded-b-lg border border-t-0 border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-1.5 text-sm">
              {modelSelector}
              <div className="ml-auto flex items-center gap-1">{actions}</div>
            </div>
          )}
        </div>
        {authState.kind === 'unauthenticated' && (
          <CloudflareConnectLegalNotice
            // Left-aligned and set to the composer's own measure: centred prose inside a
            // left-aligned column reads as a separate island rather than a footnote to the field
            // it belongs to.
            className="mt-2 px-1 text-[11px] leading-snug text-content-tertiary"
          />
        )}
      </div>
      {controller.refinement && (
        <PromptRefinementDialog
          key={controller.refinement.questions.map((question) => question.id).join(':')}
          questions={controller.refinement.questions}
          isLoading={controller.isEnhancing}
          onSubmit={(answers) => void controller.answerRefinementQuestions(answers)}
          onCancel={controller.cancelRefinement}
        />
      )}
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
  contentClassName,
}: {
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onChange: ChangeEventHandler<HTMLTextAreaElement>;
  value: string;
  minHeight: number;
  maxHeight: number;
  placeholder: string;
  disabled: boolean;
  contentClassName?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = `${ref.current.scrollHeight}px`;
    }
  }, [value]);

  return (
    <div className="relative overflow-y-auto" style={{ minHeight, maxHeight }}>
      <textarea
        ref={ref}
        className={classNames(
          'block w-full appearance-none resize-none bg-transparent px-3 py-3 text-sm leading-snug text-content-primary outline-none placeholder-content-tertiary',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'scrollbar-thin scrollbar-track-transparent scrollbar-thumb-macosScrollbar-thumb',
          contentClassName,
        )}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onChange={onChange}
        value={value}
        style={{ minHeight }}
        placeholder={placeholder}
        aria-label={placeholder}
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
