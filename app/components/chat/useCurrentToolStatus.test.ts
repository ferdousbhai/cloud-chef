import { describe, expect, it } from 'vitest';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { makePartId } from 'cloudchef-agent/partId';
import { currentToolStatus } from './useCurrentToolStatus';

describe('currentToolStatus', () => {
  it('ignores active tool state from another transcript', () => {
    const previous = message('previous');
    const activities = {
      [makePartId(previous.id, 0)]: {
        invocation: {
          type: 'dynamic-tool',
          state: 'input-available',
          toolCallId: 'validate-1',
          toolName: 'validateProject',
          input: {},
        },
        status: 'running' as const,
      },
    } satisfies Parameters<typeof currentToolStatus>[1];

    expect(currentToolStatus([], activities)).toEqual([]);
    expect(currentToolStatus([previous], activities)).toEqual(['validateProject']);
  });
});

function message(id: string): CloudChefMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'dynamic-tool',
        state: 'input-available',
        toolCallId: 'validate-1',
        toolName: 'validateProject',
        input: {},
      },
    ],
  };
}
