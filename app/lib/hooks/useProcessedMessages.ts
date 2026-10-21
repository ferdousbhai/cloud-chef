import { useCallback, useRef, useState } from 'react';
import { makePartId, type PartId } from 'cloudchef-agent/partId';
import { getToolInvocation, isToolPart, type CloudChefMessage, type CloudChefPart } from 'cloudchef-agent/ai-compat';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';

export type PartCache = Map<PartId, Part>;

type Part = CloudChefPart;

function isPartMaybeEqual(a: Part, b: Part): boolean {
  if (a.type === 'text' && b.type === 'text') {
    return a.text === b.text;
  }
  const aInvocation = getToolInvocation(a);
  const bInvocation = getToolInvocation(b);
  if (
    aInvocation &&
    bInvocation &&
    aInvocation.state.startsWith('output-') &&
    bInvocation.state.startsWith('output-')
  ) {
    return (
      aInvocation.toolCallId === bInvocation.toolCallId &&
      aInvocation.state === bInvocation.state &&
      aInvocation.errorText === bInvocation.errorText &&
      // A settled output can still be replaced in place (a publish's pending build becomes its result), and
      // each broadcast carries freshly parsed objects, so equal outputs are recognized by their JSON.
      (aInvocation.output === bInvocation.output || outputJson(a) === outputJson(b))
    );
  }
  return false;
}

/**
 * A part's output serialized once, so the cached part's large settled output is not re-serialized on every
 * update. Kept with the output it was made from, so an output replaced on the same part is serialized again.
 */
const outputJsonCache = new WeakMap<Part, { output: Part['output']; json: string | undefined }>();

function outputJson(part: Part): string | undefined {
  const cached = outputJsonCache.get(part);
  if (cached && cached.output === part.output) {
    return cached.json;
  }
  const json = JSON.stringify(part.output);
  outputJsonCache.set(part, { output: part.output, json });
  return json;
}

function recordToolPart(partId: PartId, part: Part): void {
  const toolInvocation = getToolInvocation(part);
  if (!toolInvocation) {
    return;
  }
  toolActivityStore.record(partId, toolInvocation);
}

export function processMessage(message: CloudChefMessage, previousParts: PartCache): CloudChefMessage {
  if (message.role === 'user') {
    return message;
  }
  if (!message.parts) {
    throw new Error('Message has no parts');
  }
  const parsedParts = [];
  for (let i = 0; i < message.parts.length; i++) {
    const part = message.parts[i];
    const partId = makePartId(message.id, i);
    // Reuse the cached part object so its reference stays stable for the parsed-message comparison.
    const cacheEntry = previousParts.get(partId);
    if (cacheEntry && isPartMaybeEqual(cacheEntry, part)) {
      parsedParts.push(cacheEntry);
      continue;
    }
    if (isToolPart(part)) {
      recordToolPart(partId, part);
    }
    parsedParts.push(part);
    previousParts.set(partId, part);
  }
  return {
    ...message,
    parts: parsedParts,
  };
}

export function useProcessedMessages(partCache: PartCache) {
  const [parsedMessages, setParsedMessages] = useState<CloudChefMessage[]>([]);

  const previousMessages = useRef<{ original: CloudChefMessage; parsed: CloudChefMessage }[]>([]);
  const previousParts = useRef<PartCache>(partCache);

  const processMessages = useCallback((messages: CloudChefMessage[]) => {
    const nextPrevMessages: { original: CloudChefMessage; parsed: CloudChefMessage }[] = [];
    const prevMessages = previousMessages.current;

    for (let i = 0; i < messages.length; i++) {
      const prev = prevMessages[i];
      const message = messages[i];
      if (prev && prev.original === message) {
        nextPrevMessages.push(prev);
        continue;
      }
      const parsed = processMessage(message, previousParts.current);
      nextPrevMessages.push({ original: message, parsed });
    }

    const parsedMessagesChanged =
      prevMessages.length !== nextPrevMessages.length ||
      nextPrevMessages.some((message, index) => prevMessages[index]?.parsed !== message.parsed);

    previousMessages.current = nextPrevMessages;
    if (parsedMessagesChanged) {
      setParsedMessages(nextPrevMessages.map((message) => message.parsed));
    }
  }, []);

  return { parsedMessages, processMessages };
}
