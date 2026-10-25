import { describe, expect, it } from 'vitest';
import { toolSuccess } from 'cloudchef-agent/tool-result';
import { linkedProjectModelTools, type LinkedProjectModelToolContext } from './linked-project-model-tools';

function recordingContext() {
  const published: { input: { message: string; live: boolean }; toolCallId: string }[] = [];
  const context: LinkedProjectModelToolContext = {
    repository: 'ada/site',
    defaultBranch: 'main',
    publish: async (input, options) => {
      published.push({ input, toolCallId: options.toolCallId });
      return toolSuccess('Committed');
    },
  };
  return { context, published };
}

describe("a team project's tools", () => {
  it('publishes with the call it came from, so the build result can find its way back to it', async () => {
    const { context, published } = recordingContext();
    const tools = linkedProjectModelTools(context);
    await tools.publish_preview.execute({ message: 'Hero copy' }, { toolCallId: 'call-preview' });
    await tools.publish.execute({ message: 'Ship it' }, { toolCallId: 'call-live' });
    expect(published).toEqual([
      { input: { message: 'Hero copy', live: false }, toolCallId: 'call-preview' },
      { input: { message: 'Ship it', live: true }, toolCallId: 'call-live' },
    ]);
    expect(tools.publish_preview.description).toContain('nothing needs waiting or polling for');
    expect(tools.publish.description).toContain('above the chat composer');
  });
});
