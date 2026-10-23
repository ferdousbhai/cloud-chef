import { describe, expect, it } from 'vitest';
import { toolSuccess } from 'cloudchef-agent/tool-result';
import { linkedProjectModelTools, type LinkedProjectModelToolContext } from './linked-project-model-tools';

function recordingContext() {
  const published: { input: { message: string; live: boolean }; toolCallId: string }[] = [];
  const fetched: Parameters<LinkedProjectModelToolContext['fetchSite']>[0][] = [];
  const context: LinkedProjectModelToolContext = {
    repository: 'ada/site',
    defaultBranch: 'main',
    publish: async (input, options) => {
      published.push({ input, toolCallId: options.toolCallId });
      return toolSuccess('Committed');
    },
    fetchSite: async (input) => {
      fetched.push(input);
      return toolSuccess('Read');
    },
  };
  return { context, published, fetched };
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
    expect(tools.publish_preview.description).toContain('Do not wait or poll');
    expect(tools.publish.description).toContain('above the chat composer');
  });

  it('reads the live site with its validated input only', async () => {
    const { context, fetched } = recordingContext();
    const tools = linkedProjectModelTools(context);
    await tools.fetch_site.execute(
      { url: 'https://example.com/about', format: 'html', offset: 10 },
      { toolCallId: 'call-site' },
    );
    expect(fetched).toEqual([{ url: 'https://example.com/about', format: 'html', offset: 10 }]);
    expect(() => tools.fetch_site.execute({ url: '' }, { toolCallId: 'call-bad' })).toThrow();
    expect(() =>
      tools.fetch_site.execute({ url: 'https://example.com', offset: -1 }, { toolCallId: 'call-bad' }),
    ).toThrow();
    expect(fetched).toHaveLength(1);
    expect(tools.fetch_site.description).toContain("ada/site's own live site");
  });
});
