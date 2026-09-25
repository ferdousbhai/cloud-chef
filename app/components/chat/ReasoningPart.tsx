import { CaretDownIcon, CaretUpIcon } from '@radix-ui/react-icons';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { CloudChefPart } from 'cloudchef-agent/ai-compat';
import { formatDuration } from './build-progress';

/** Characters of the tail kept for the collapsed preview; the rest only renders when expanded. */
const PREVIEW_TAIL_CHARACTERS = 400;

/**
 * The preview clips the older lines rather than the newest ones, so the fade belongs at the top.
 * It is a mask, not paint: the block keeps one flat colour.
 */
const PREVIEW_FADE = 'linear-gradient(to bottom, transparent, rgb(0 0 0) 1.1rem)';

/** A reasoning part carries model output, so its fields are read rather than assumed. */
const reasoningPartSchema = z.looseObject({
  text: z.string().catch(''),
  state: z.string().catch(''),
});

type ReasoningPartView = {
  text: string;
  streaming: boolean;
};

/** What the transcript's reasoning part actually holds: its text, and whether it is still growing. */
export function reasoningPartView(part: CloudChefPart): ReasoningPartView {
  const parsed = reasoningPartSchema.safeParse(part).data;
  return { text: parsed?.text ?? '', streaming: parsed?.state === 'streaming' };
}

/**
 * The model's own reasoning, shown while it streams so a long silent think is legible, and quiet
 * once it ends. It never grows past two lines collapsed, and scrolls inside itself when expanded.
 */
export function ReasoningPart({ part, isActive = true }: { part: CloudChefPart; isActive?: boolean }) {
  const view = reasoningPartView(part);
  const { text } = view;
  const streaming = isActive && view.streaming;
  const [expanded, setExpanded] = useState(false);
  const startedAtRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [durationMs, setDurationMs] = useState<number | null>(null);

  useEffect(() => {
    if (!streaming) {
      // A part that finished in this session reports how long it took. One restored from the
      // transcript never started here, so it reports nothing rather than guessing.
      const startedAt = startedAtRef.current;
      if (startedAt !== null) {
        startedAtRef.current = null;
        setDurationMs(Date.now() - startedAt);
      }
      return () => undefined;
    }
    startedAtRef.current ??= Date.now();
    const tick = () => setElapsedMs(Date.now() - (startedAtRef.current ?? Date.now()));
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, [streaming]);

  const label = streaming
    ? elapsedMs >= 1_000
      ? `Thinking… ${formatDuration(elapsedMs)}`
      : 'Thinking…'
    : durationMs === null
      ? 'Thought'
      : `Thought for ${formatDuration(durationMs)}`;
  const tail = text.length > PREVIEW_TAIL_CHARACTERS ? text.slice(-PREVIEW_TAIL_CHARACTERS) : text;

  return (
    <div className="flex w-full flex-col overflow-hidden rounded-md border border-bolt-elements-artifacts-borderColor bg-bolt-elements-artifacts-background">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((visible) => !visible)}
        className="flex min-w-0 items-center gap-2 px-2.5 py-1 text-left text-[11px] text-content-tertiary outline-none transition-colors hover:text-content-secondary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
      >
        <span className="truncate">{label}</span>
        <span className="grow" />
        <span className="shrink-0 text-content-tertiary">{expanded ? <CaretUpIcon /> : <CaretDownIcon />}</span>
      </button>
      {!expanded && streaming && tail !== '' && (
        <div
          aria-hidden="true"
          className="relative h-7 overflow-hidden"
          style={{ maskImage: PREVIEW_FADE, WebkitMaskImage: PREVIEW_FADE }}
        >
          <div className="absolute inset-x-2.5 bottom-1 whitespace-pre-wrap break-words text-[11px] leading-4 text-content-tertiary">
            {tail}
          </div>
        </div>
      )}
      {expanded && (
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-t border-bolt-elements-artifacts-borderColor px-2.5 py-1.5 text-[11px] leading-4 text-content-tertiary">
          {text === '' ? 'No reasoning was recorded.' : text}
        </div>
      )}
    </div>
  );
}
