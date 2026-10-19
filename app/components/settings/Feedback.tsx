/** What an action said, shown next to it: an error (announced, in the error color) or a plain note. */
export type Feedback = { text: string; error: boolean } | null;

export function errorFeedback(text: string | null): Feedback {
  return text === null ? null : { text, error: true };
}

export function noteFeedback(text: string): Feedback {
  return { text, error: false };
}

export function FeedbackLine({ feedback, className = 'mt-2' }: { feedback: Feedback; className?: string }) {
  if (!feedback) {
    return null;
  }
  return feedback.error ? (
    <p className={`${className} text-sm text-bolt-elements-icon-error [overflow-wrap:anywhere]`} role="alert">
      {feedback.text}
    </p>
  ) : (
    <p className={`${className} text-sm text-content-secondary [overflow-wrap:anywhere]`} role="status">
      {feedback.text}
    </p>
  );
}
