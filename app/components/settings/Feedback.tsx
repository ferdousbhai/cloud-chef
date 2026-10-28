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
  return (
    <p
      className={`${className} text-sm ${feedback.error ? 'text-bolt-elements-icon-error' : 'text-content-secondary'} wrap-anywhere`}
      role={feedback.error ? 'alert' : 'status'}
    >
      {feedback.text}
    </p>
  );
}
