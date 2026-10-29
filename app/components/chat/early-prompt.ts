/**
 * The home's prompt box is a plain textarea from the first paint, before the real editor's code has loaded, so
 * what someone types straight away is kept. Each time that early box is replaced — by the hydrated copy of
 * itself, and then by the real editor — it hands over its text, its caret and whether it had focus, and the box
 * that takes its place picks them up, so no keystroke is lost between them.
 */
type EarlyPrompt = { value: string; selectionStart: number; selectionEnd: number; focused: boolean };

let handedOver: EarlyPrompt | null = null;

/** The classes the early box and the real editor's textarea share, so the swap between them looks like nothing. */
export const PROMPT_TEXTAREA_CLASS =
  'block w-full appearance-none resize-none overflow-hidden bg-transparent text-sm leading-snug text-content-primary outline-hidden placeholder-content-tertiary p-3';

/** The ref of the early box: picks up what an earlier copy of it held, and hands it on when it is replaced. */
export function holdEarlyPrompt(textarea: HTMLTextAreaElement | null) {
  if (!textarea) {
    return;
  }
  // Typed before the page's script ran, into the server's copy of this box, which this one replaced.
  restore(textarea, handedOver);
  return () => {
    handedOver = read(textarea);
  };
}

/**
 * Moves what the early box held into the real editor's textarea, as it mounts: the text, the caret, and the focus.
 * Called in the commit that removed the early box, so no key can land between the two. Returns the text moved.
 */
export function adoptEarlyPrompt(textarea: HTMLTextAreaElement): string | null {
  const prompt = handedOver;
  handedOver = null;
  if (!prompt || (prompt.value.length === 0 && !prompt.focused)) {
    return null;
  }
  textarea.value = prompt.value;
  restoreEarlyPromptCaret(textarea, prompt);
  return prompt.value;
}

function restoreEarlyPromptCaret(textarea: HTMLTextAreaElement, prompt: EarlyPrompt) {
  if (prompt.focused) {
    textarea.focus();
  }
  textarea.setSelectionRange(prompt.selectionStart, prompt.selectionEnd);
}

function read(textarea: HTMLTextAreaElement): EarlyPrompt {
  return {
    value: textarea.value,
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
    focused: textarea.ownerDocument.activeElement === textarea,
  };
}

function restore(textarea: HTMLTextAreaElement, prompt: EarlyPrompt | null) {
  if (!prompt) {
    return;
  }
  if (textarea.value.length === 0) {
    textarea.value = prompt.value;
  }
  restoreEarlyPromptCaret(textarea, prompt);
}
