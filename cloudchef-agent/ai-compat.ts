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

export type CloudChefToolInvocation = {
  type: 'dynamic-tool';
  toolName: string;
  toolCallId: string;
  state: string;
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
    state: typeof fields.state === 'string' ? fields.state : 'input-streaming',
  };
  if (typeof fields.errorText === 'string') {
    invocation.errorText = fields.errorText;
  }
  return invocation;
}

export function isToolInvocationInProgress(invocation: Pick<CloudChefToolInvocation, 'state'>): boolean {
  return invocation.state === 'input-streaming' || invocation.state === 'input-available';
}

/** The tool-carrying fields a part may expose, before any of them are known to be well-formed. */
type ToolInvocationFields = {
  type: string;
  toolName?: unknown;
  toolCallId?: unknown;
  state?: unknown;
  errorText?: unknown;
};
