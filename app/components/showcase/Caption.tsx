import { useState } from 'react';
import { PersonLink } from './ShowcaseLinks';

const FOLDED_LENGTH = 140;

/**
 * A post's caption after its author's name, as a picture feed shows it: a long one folds to its first lines with
 * "more". It is plain text: whatever its author wrote is shown as written, never as markup.
 */
export function Caption({ username, text, folded = true }: { username: string; text: string; folded?: boolean }) {
  const [open, setOpen] = useState(!folded || text.length <= FOLDED_LENGTH);
  return (
    <p className="wrap-anywhere whitespace-pre-line text-sm text-content-primary">
      <PersonLink
        username={username}
        className="mr-1.5 font-semibold text-content-primary no-underline hover:underline"
      >
        {username}
      </PersonLink>
      {open ? text : `${text.slice(0, FOLDED_LENGTH).trimEnd()}… `}
      {open ? null : (
        <button type="button" className="text-content-tertiary hover:underline" onClick={() => setOpen(true)}>
          more
        </button>
      )}
    </p>
  );
}
