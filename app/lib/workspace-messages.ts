/**
 * What the chat and the code view say about a workspace that isn't ready: one wording, so the two never
 * disagree about the same state.
 */
export const WORKSPACE_MESSAGES = {
  loading: 'Loading project files…',
  reconnecting: 'Reconnecting to your workspace…',
  /** Before the agent's own reason, which says what went wrong. */
  failed: 'CloudChef could not open this project.',
  unavailable: 'CloudChef could not reach your workspace.',
  /** The browser has stopped trying: nothing reconnects until the person does. */
  unavailableDetail: 'Chat is paused. Reconnect to continue.',
  editorFailed: "The editor could not load this project's files.",
  editorFailedDetail: 'Chat, builds, and previews still work.',
} as const;
