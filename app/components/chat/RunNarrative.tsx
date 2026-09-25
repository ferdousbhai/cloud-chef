import { lazy, Suspense, useId, useState } from 'react';
import type { CloudChefPart } from 'cloudchef-agent/ai-compat';
import { DetailsToggle } from './DetailsToggle';

const Markdown = lazy(() => import('./Markdown').then((module) => ({ default: module.Markdown })));

/** A run's latest narrative stands in for the whole run; earlier updates stay one click away. */
export function RunNarrative({ parts }: { parts: CloudChefPart[] }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const texts = parts.flatMap((part) => (part.type === 'text' && part.text?.trim() ? [part.text] : []));
  const latest = texts.at(-1);
  if (latest === undefined) {
    return null;
  }
  const earlier = texts.slice(0, -1);
  return (
    <div className="flex w-full flex-col gap-1 overflow-hidden text-[13px] leading-6">
      <Suspense fallback={null}>
        {earlier.length > 0 && (
          <DetailsToggle expanded={expanded} controls={detailsId} onToggle={() => setExpanded(!expanded)} />
        )}
        {expanded && (
          <div
            id={detailsId}
            className="flex flex-col gap-1 border-l-2 border-bolt-elements-borderColor pl-3 text-content-secondary"
          >
            {earlier.map((text, index) => (
              <Markdown key={index}>{text}</Markdown>
            ))}
          </div>
        )}
        <Markdown>{latest}</Markdown>
      </Suspense>
    </div>
  );
}
