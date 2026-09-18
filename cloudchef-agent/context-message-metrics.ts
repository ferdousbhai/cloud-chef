import {
  getToolInvocation,
  type CloudChefMessage,
  type CloudChefPart,
  type CloudChefToolInvocation,
} from './ai-compat.js';

export type PromptCharacterCounts = {
  messageHistoryChars: number;
  currentTurnChars: number;
  totalPromptChars: number;
};

export function calculatePromptCharacterCounts(messages: CloudChefMessage[], systemPrompt = ''): PromptCharacterCounts {
  const currentTurnIndex = messages.at(-1)?.role === 'user' ? messages.length - 1 : -1;
  let messageHistoryChars = 0;
  let currentTurnChars = 0;

  messages.forEach((message, index) => {
    const size = messageCharacterCount(message);
    if (index === currentTurnIndex) {
      currentTurnChars += size;
    } else {
      messageHistoryChars += size;
    }
  });

  return {
    messageHistoryChars,
    currentTurnChars,
    totalPromptChars: messageHistoryChars + currentTurnChars + systemPrompt.length,
  };
}

function messageCharacterCount(message: CloudChefMessage): number {
  return message.parts.reduce((total, part) => total + partCharacterCount(part), 0);
}

function partCharacterCount(part: CloudChefPart): number {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return stringLength(part.text);
    case 'file':
      return stringLength(part.url) + stringLength(part.mediaType);
    case 'source-url':
      return stringLength(part.title) + stringLength(part.url);
    case 'source-document':
      return stringLength(part.title) + stringLength(part.mediaType);
    case 'step-start':
      return 0;
    default: {
      const invocation = getToolInvocation(part);
      if (!invocation) {
        return stringifyLength(part);
      }
      return stringifyLength(invocation.input) + terminalCharacterCount(invocation);
    }
  }
}

/** Only a settled tool call carries a terminal payload; in-progress states contribute nothing. */
function terminalCharacterCount(invocation: CloudChefToolInvocation): number {
  switch (invocation.state) {
    case 'output-available':
      return stringifyLength(invocation.output);
    case 'output-error':
      return stringLength(invocation.errorText);
    case 'output-denied':
      return stringifyLength(invocation.approval?.reason);
    default:
      return 0;
  }
}

function stringLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

function stringifyLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}
