import { describe, expect, it } from 'vitest';
import type { CloudChefMessage } from './ai-compat.js';
import { applyChatFrame, chatFrameChange } from './chat-frame.js';

const user: CloudChefMessage = { id: '1', role: 'user', parts: [{ type: 'text', text: 'Build it' }] };
const working: CloudChefMessage = {
  id: '1-a',
  role: 'assistant',
  parts: [
    { type: 'text', text: 'Reading.', state: 'done' },
    { type: 'dynamic-tool', toolName: 'read', toolCallId: 'c1', state: 'input-available' },
  ],
};

describe('chat frames', () => {
  it("sends only the parts of the message that changed, and the browser's chat comes out the same", () => {
    const next: CloudChefMessage[] = [
      user,
      {
        ...working,
        parts: [
          working.parts[0]!,
          { type: 'dynamic-tool', toolName: 'read', toolCallId: 'c1', state: 'output-available', output: 'x' },
        ],
      },
    ];

    const change = chatFrameChange([user, working], next);

    expect(change).toEqual({ from: 1, keepParts: 1, messages: [{ ...working, parts: [next[1]!.parts[1]] }] });
    expect(applyChatFrame([user, working], change!)).toEqual(next);
  });

  it('sends a new message whole, and nothing when nothing changed', () => {
    const steered: CloudChefMessage = { id: '5', role: 'user', parts: [{ type: 'text', text: 'Also tests' }] };

    expect(chatFrameChange([user, working], [user, working, steered])).toEqual({
      from: 2,
      keepParts: 0,
      messages: [steered],
    });
    expect(chatFrameChange([user, working], [user, working])).toBeNull();
    expect(applyChatFrame([], { from: 0, keepParts: 0, messages: [user, working] })).toEqual([user, working]);
  });
});
