/** A provider rejection body is unbounded; the chat line only needs the head of it. */
const MAX_PROVIDER_REASON_CHARACTERS = 300;

/**
 * What the chat says when a model request failed. It reaches only the account owner's own chat, so the provider's own
 * wording is carried through: without it every distinct failure (a truncated stream, a rejected request body, a 400
 * naming the offending field) reads as one generic sentence and cannot be acted on. The reason must not also be logged.
 */
export function providerFailureText(reason: string): string {
  const trimmed = reason.trim().replace(/[.\s]+$/, '');
  if (!trimmed) {
    return 'The model request failed. Please retry.';
  }
  if (trimmed.length > MAX_PROVIDER_REASON_CHARACTERS) {
    return `The model request failed: ${trimmed.slice(0, MAX_PROVIDER_REASON_CHARACTERS)}… Retry, or pick a different model.`;
  }
  return `The model request failed: ${trimmed}. Retry, or pick a different model.`;
}
