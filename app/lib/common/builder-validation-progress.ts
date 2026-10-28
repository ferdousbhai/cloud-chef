/**
 * Stages the canonical validation reports as it runs. `computer validation` is the honest answer
 * before the workspace has said anything more specific — the operation is running in the user's
 * Cloudflare Computer container, and no finer stage has been observed yet. Every other value is
 * reported by the workspace runtime itself as it enters that step, so the UI never guesses.
 */
export type BuilderValidationStage =
  'computer validation' | 'preparing' | 'installing' | 'typecheck' | 'lint' | 'build' | 'packaging' | 'finalizing';
