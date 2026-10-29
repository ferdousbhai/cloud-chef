import { CaretDownIcon, CaretUpIcon } from '@radix-ui/react-icons';
import { lazy, Suspense, useId, useState } from 'react';

const Markdown = lazy(() => import('./Markdown').then((module) => ({ default: module.Markdown })));

/**
 * A quiet line in the chat where the conversation went on from a handoff note: closed by default, and opened to read
 * the note, which renders as the chat renders the agent's own words.
 */
export function HandoffNotice({ note }: { note: string }) {
  const [expanded, setExpanded] = useState(false);
  const noteId = useId();
  return (
    <div className="flex w-full flex-col overflow-hidden rounded-md border border-bolt-elements-artifacts-borderColor bg-bolt-elements-artifacts-background">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={noteId}
        onClick={() => setExpanded((open) => !open)}
        className="flex min-w-0 items-center gap-2 px-2.5 py-1 text-left text-xs text-content-tertiary outline-hidden transition-colors hover:text-content-secondary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
      >
        <span className="truncate">Continued from a handoff note</span>
        <span className="grow" />
        <span className="shrink-0">{expanded ? <CaretUpIcon /> : <CaretDownIcon />}</span>
      </button>
      {expanded && (
        <div
          id={noteId}
          className="max-h-64 overflow-y-auto border-t border-bolt-elements-artifacts-borderColor px-2.5 py-1.5 text-xs text-content-secondary"
        >
          <p className="mb-1.5 text-content-tertiary">
            This conversation got long, so CloudChef wrote this note and carried on from it. Everything above is still
            here for you.
          </p>
          <Suspense fallback={<div className="whitespace-pre-wrap wrap-break-word">{note}</div>}>
            <Markdown>{note}</Markdown>
          </Suspense>
        </div>
      )}
    </div>
  );
}
