import type { CloudChefToolResult } from 'cloudchef-agent/tool-result';
import { MODEL_TOOL_INPUT_SCHEMAS, type LinkedProjectModelToolName } from 'cloudchef-agent/model-tool-inputs';
import type { Tool } from 'cloudchef-agent/tool';
import type { LinkedSiteFetchInput } from './linked-site-fetch';

/**
 * A turn working on an organization's GitHub project. Its changes go back to GitHub, and the
 * repository's own pipeline (Workers Builds, typically) previews and deploys them.
 */
export type LinkedProjectModelToolContext = {
  repository: string;
  defaultBranch: string;
  /**
   * Commits the workspace to the member's branch; `live` also merges it into the default branch.
   * It returns once the commit is on GitHub; the pipeline's result replaces the output when it reports.
   */
  publish(
    input: { message: string; live: boolean },
    options: { toolCallId: string; abortSignal?: AbortSignal },
  ): Promise<CloudChefToolResult>;
  /** Reads a page of the project's own live site or one of its preview links. */
  fetchSite(input: LinkedSiteFetchInput, options: { abortSignal?: AbortSignal }): Promise<CloudChefToolResult>;
};

/** The tools a GitHub project's turn adds. */
export function linkedProjectModelTools(context: LinkedProjectModelToolContext) {
  return {
    publish_preview: {
      description:
        `Commit the workspace's changes to your own branch of ${context.repository} on GitHub. It returns as ` +
        "soon as the commit is there; the repository's pipeline then builds the branch (about two minutes), and " +
        "its result and preview link appear on this tool's card in the chat by themselves, and in this tool's " +
        'output next turn. Do not wait or poll for it.',
      inputSchema: MODEL_TOOL_INPUT_SCHEMAS.publish_preview,
      execute: (input, options) =>
        context.publish(
          { message: MODEL_TOOL_INPUT_SCHEMAS.publish_preview.parse(input).message, live: false },
          options,
        ),
    },
    publish: {
      description:
        `Put the workspace's changes live: commit them and merge them into ${context.defaultBranch} of ` +
        `${context.repository}, which the repository's pipeline deploys to production; the build's result appears ` +
        'on the card when it reports. Use it only when the user wants the change live.',
      inputSchema: MODEL_TOOL_INPUT_SCHEMAS.publish,
      execute: (input, options) =>
        context.publish({ message: MODEL_TOOL_INPUT_SCHEMAS.publish.parse(input).message, live: true }, options),
    },
    fetch_site: {
      description:
        `Read a page or API response from ${context.repository}'s own live site: its production address (the ` +
        "repository's homepage on GitHub) or a preview link its pipeline reported. Use it to see the site's " +
        'current content, including copy kept in its database or CMS and served by its pages or JSON endpoints, ' +
        'instead of fetching it with exec. Read-only GET; text formats only; long responses come in pages.',
      inputSchema: MODEL_TOOL_INPUT_SCHEMAS.fetch_site,
      execute: (input, options) => context.fetchSite(MODEL_TOOL_INPUT_SCHEMAS.fetch_site.parse(input), options),
    },
  } satisfies Record<LinkedProjectModelToolName, Tool>;
}
