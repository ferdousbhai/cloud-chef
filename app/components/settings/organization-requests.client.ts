import { messageOf } from '~/lib/json-request';

/** Runs one admin action, then refreshes, or shows why it failed. */
export async function run(
  action: () => Promise<void>,
  then: () => void | Promise<void>,
  onError: (message: string | null) => void,
): Promise<void> {
  onError(null);
  try {
    await action();
    await then();
  } catch (failure) {
    onError(messageOf(failure, 'That did not work. Try again.'));
  }
}
