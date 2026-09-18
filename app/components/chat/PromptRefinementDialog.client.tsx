import { useState, type FormEvent } from 'react';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { Spinner } from '@ui/Spinner';
import {
  MAX_PROMPT_REFINEMENT_ANSWER_CHARACTERS,
  type PromptRefinementAnswer,
  type PromptRefinementQuestion,
} from '~/lib/prompt-refinement';
import { classNames } from '~/utils/classNames';

interface DraftAnswer {
  selectedOptionIds: string[];
  customInput?: string;
  note?: string;
}

export function PromptRefinementDialog({
  questions,
  isLoading,
  onSubmit,
  onCancel,
}: {
  questions: PromptRefinementQuestion[];
  isLoading: boolean;
  onSubmit: (answers: PromptRefinementAnswer[]) => void;
  onCancel: () => void;
}) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>({});
  const question = questions[questionIndex]!;
  const draft = drafts[question.id] ?? { selectedOptionIds: [] };
  const hasAnswer =
    draft.customInput !== undefined ? draft.customInput.trim().length > 0 : draft.selectedOptionIds.length > 0;

  const updateDraft = (next: Partial<DraftAnswer>) => {
    setDrafts((current) => ({
      ...current,
      [question.id]: { ...(current[question.id] ?? { selectedOptionIds: [] }), ...next },
    }));
  };

  const selectOption = (optionId: string) => {
    if (isLoading) {
      return;
    }
    const selectedOptionIds = question.multi
      ? draft.selectedOptionIds.includes(optionId)
        ? draft.selectedOptionIds.filter((id) => id !== optionId)
        : [...draft.selectedOptionIds, optionId]
      : [optionId];
    updateDraft({ selectedOptionIds, customInput: undefined });
  };

  const continueOrSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!hasAnswer || isLoading) {
      return;
    }
    if (questionIndex < questions.length - 1) {
      setQuestionIndex((index) => index + 1);
      return;
    }
    onSubmit(
      questions.map((item) => {
        const answer = drafts[item.id] ?? (item.id === question.id ? draft : { selectedOptionIds: [] });
        const customInput = answer.customInput?.trim();
        const note = answer.note?.trim();
        const refinement: PromptRefinementAnswer = {
          questionId: item.id,
          question: item.question,
          selectedOptions: customInput
            ? []
            : answer.selectedOptionIds.map((id) => item.options.find((option) => option.id === id)!.label),
        };
        if (customInput) {
          refinement.customInput = customInput;
        }
        if (note) {
          refinement.note = note;
        }
        return refinement;
      }),
    );
  };

  return (
    <Modal
      onClose={onCancel}
      title="Build plan"
      description={questions.length > 1 ? `Question ${questionIndex + 1} of ${questions.length}` : undefined}
    >
      <form onSubmit={continueOrSubmit}>
        <section aria-labelledby={`prompt-refinement-${question.id}`}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent-500">
              {question.header}
            </span>
            {question.multi && <span className="text-xs text-content-tertiary">Choose all that apply</span>}
          </div>
          <h2
            id={`prompt-refinement-${question.id}`}
            className="text-lg font-semibold leading-snug text-content-primary"
          >
            {question.question}
          </h2>

          <div className="mt-4 grid gap-2" role="group" aria-label="Plan choices">
            {question.options.map((option) => {
              const recommended = option.id === question.recommendedOptionId;
              const selected = draft.customInput === undefined && draft.selectedOptionIds.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={isLoading}
                  aria-pressed={selected}
                  onClick={() => selectOption(option.id)}
                  className={classNames(
                    'group w-full rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:cursor-wait disabled:opacity-60',
                    selected
                      ? 'border-accent-500 bg-accent-500/10'
                      : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 hover:border-accent-500/60 hover:bg-bolt-elements-background-depth-3',
                  )}
                >
                  <span className="flex flex-wrap items-start justify-between gap-3">
                    <span className="font-medium text-content-primary">{option.label}</span>
                    {recommended && (
                      <span className="shrink-0 rounded bg-accent-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-500">
                        Recommended
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block text-sm leading-relaxed text-content-secondary">
                    {option.description}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-4">
            <label htmlFor="prompt-refinement-custom-answer" className="text-sm font-medium text-content-primary">
              Or write an answer
            </label>
            <textarea
              id="prompt-refinement-custom-answer"
              rows={2}
              maxLength={MAX_PROMPT_REFINEMENT_ANSWER_CHARACTERS}
              value={draft.customInput ?? ''}
              disabled={isLoading}
              onChange={(event) => updateDraft({ selectedOptionIds: [], customInput: event.target.value })}
              placeholder="Type a different answer…"
              className="mt-2 w-full resize-y rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-2 text-sm text-content-primary outline-none placeholder:text-content-tertiary focus:border-accent-500"
            />
          </div>

          {draft.note !== undefined ? (
            <div className="mt-3 rounded-lg border border-bolt-elements-borderColor p-3">
              <label htmlFor="prompt-refinement-note" className="text-sm font-medium text-content-primary">
                Clarification note <span className="font-normal text-content-tertiary">(optional)</span>
              </label>
              <textarea
                id="prompt-refinement-note"
                autoFocus
                rows={2}
                maxLength={MAX_PROMPT_REFINEMENT_ANSWER_CHARACTERS}
                value={draft.note}
                disabled={isLoading}
                onChange={(event) => updateDraft({ note: event.target.value })}
                placeholder="Add context, constraints, or an exception to your choice…"
                className="mt-2 w-full resize-y rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-2 text-sm text-content-primary outline-none placeholder:text-content-tertiary focus:border-accent-500"
              />
              <button
                type="button"
                disabled={isLoading}
                onClick={() => updateDraft({ note: undefined })}
                className="mt-2 text-sm font-medium text-content-secondary underline decoration-bolt-elements-borderColor underline-offset-4 hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
              >
                Remove note
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={isLoading}
              onClick={() => updateDraft({ note: '' })}
              className="mt-3 text-sm font-medium text-content-secondary underline decoration-bolt-elements-borderColor underline-offset-4 hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              Add a note
            </button>
          )}

          <div className="mt-5 flex min-h-9 flex-wrap items-center justify-between gap-3 border-t border-bolt-elements-borderColor pt-4">
            <Button variant="subtle" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-content-secondary" aria-live="polite">
                  <Spinner className="size-4" />
                  <span>Applying your decisions…</span>
                </div>
              ) : (
                <>
                  {questionIndex > 0 && (
                    <Button variant="subtle" size="sm" onClick={() => setQuestionIndex((index) => index - 1)}>
                      Back
                    </Button>
                  )}
                  <Button type="submit" size="sm" disabled={!hasAnswer}>
                    {questionIndex < questions.length - 1 ? 'Next decision' : 'Submit answers'}
                  </Button>
                </>
              )}
            </div>
          </div>
        </section>
      </form>
    </Modal>
  );
}
