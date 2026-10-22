// Pi-native CloudChef message — kept structurally compatible with UIMessage parts shapes used by chat UI.
export type CloudChefPart = {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  data?: unknown;
  url?: unknown;
  mediaType?: unknown;
  title?: unknown;
} & Record<string, unknown>;

export type ToolInvocationState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error';

export type CloudChefToolInvocation = {
  type: 'dynamic-tool';
  toolName: string;
  toolCallId: string;
  state: ToolInvocationState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
} & Record<string, unknown>;

export type CloudChefMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: CloudChefPart[];
  metadata?: unknown;
  createdAt?: Date | number | string;
};

export function messageText(message: Pick<CloudChefMessage, 'parts'>): string {
  return message.parts.map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('');
}

export function isToolPart(part: CloudChefPart): boolean {
  return part.type === 'dynamic-tool';
}

export function getToolInvocation(part: CloudChefPart): CloudChefToolInvocation | null {
  if (!isToolPart(part)) {
    return null;
  }
  const fields: ToolInvocationFields = part;
  const invocation: CloudChefToolInvocation = {
    ...part,
    type: 'dynamic-tool',
    toolName: typeof fields.toolName === 'string' ? fields.toolName : '',
    toolCallId: typeof fields.toolCallId === 'string' ? fields.toolCallId : '',
    state: toolInvocationState(fields.state),
  };
  if (typeof fields.errorText === 'string') {
    invocation.errorText = fields.errorText;
  }
  return invocation;
}

/**
 * The messages with the part of tool call `toolCallId` swapped for what `replace` makes of it, or null
 * when no part of that call is replaced (`replace` answers null to keep one).
 */
export function replaceToolCallPart(
  messages: readonly CloudChefMessage[],
  toolCallId: string,
  replace: (part: CloudChefPart, invocation: CloudChefToolInvocation) => CloudChefPart | null,
): CloudChefMessage[] | null {
  let replaced = false;
  const next = messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      const invocation = getToolInvocation(part);
      const replacement = invocation?.toolCallId === toolCallId ? replace(part, invocation) : null;
      if (!replacement) {
        return part;
      }
      replaced = true;
      return replacement;
    }),
  }));
  return replaced ? next : null;
}

/** A part's state as one CloudChef renders: none is still streaming input, and any other (a stored `output-denied`) has ended in error. */
function toolInvocationState(state: ToolInvocationFields['state']): ToolInvocationState {
  switch (state) {
    case undefined:
    case 'input-streaming':
      return 'input-streaming';
    case 'input-available':
    case 'output-available':
    case 'output-error':
      return state;
    default:
      return 'output-error';
  }
}

/** Where a tool call stands: its input still streaming (pending), its input complete (running), or ended. */
export function toolInvocationPhase(
  invocation: Pick<CloudChefToolInvocation, 'state'>,
): 'pending' | 'running' | 'complete' {
  switch (invocation.state) {
    case 'input-streaming':
      return 'pending';
    case 'input-available':
      return 'running';
    default:
      return 'complete';
  }
}

export function isToolInvocationInProgress(invocation: Pick<CloudChefToolInvocation, 'state'>): boolean {
  return toolInvocationPhase(invocation) !== 'complete';
}

/** The tool-carrying fields a part may expose, before any of them are known to be well-formed. */
type ToolInvocationFields = {
  type: string;
  toolName?: unknown;
  toolCallId?: unknown;
  state?: unknown;
  errorText?: unknown;
};
