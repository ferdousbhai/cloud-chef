import type { CloudChefToolResult } from 'cloudchef-agent/tool-result';
import { MODEL_TOOL_INPUT_SCHEMAS, type LinkedProjectModelToolName } from 'cloudchef-agent/model-tool-inputs';
import type { Tool } from 'cloudchef-agent/tool';
import type { LinkedSiteFetchInput } from './linked-site-fetch';

/**
 * A turn working on a team project. Its changes are committed to the project's repository, and Workers
 * Builds, connected to that repository, previews and deploys them.
 */
export type LinkedProjectModelToolContext = {
  /** The project's name. */
  repository: string;
  defaultBranch: string;
  /**
   * Commits the workspace to the conversation's own branch; `live` also merges it into the default branch.
   * It returns once the commit is in the repository; the build's result replaces the output when it reports.
   */
  publish(
    input: { message: string; live: boolean },
    options: { toolCallId: string; abortSignal?: AbortSignal },
  ): Promise<CloudChefToolResult>;
  /** Reads a page of the project's own live site or one of its preview links. */
  fetchSite(input: LinkedSiteFetchInput, options: { abortSignal?: AbortSignal }): Promise<CloudChefToolResult>;
};

/** The tools a team project's turn adds. */
export function linkedProjectModelTools(context: LinkedProjectModelToolContext) {
  return {
    publish_preview: {
      description:
        `Commit the workspace's changes to a CloudChef branch of the project's repository (${context.repository}). It ` +
        'returns as soon as the commit is there; Workers Builds then builds a preview of the branch (about two ' +
        "minutes). The user sees the build status and preview link above the chat composer and on this tool's card " +
        "as soon as it reports, and you read it in this tool's output next turn, so nothing needs waiting or polling for.",
      inputSchema: MODEL_TOOL_INPUT_SCHEMAS.publish_preview,
      execute: (input, options) =>
        context.publish(
          { message: MODEL_TOOL_INPUT_SCHEMAS.publish_preview.parse(input).message, live: false },
          options,
        ),
    },
    publish: {
      description:
        `Put the workspace's changes live: commit them and merge them into ${context.defaultBranch} of the project's ` +
        `repository (${context.repository}), which Workers Builds deploys to production. It returns once merged; the ` +
        "user sees the deploy's status above the chat composer and on this tool's card when it reports, so nothing " +
        'needs waiting or polling for. Use it only when the user wants the change live.',
      inputSchema: MODEL_TOOL_INPUT_SCHEMAS.publish,
      execute: (input, options) =>
        context.publish({ message: MODEL_TOOL_INPUT_SCHEMAS.publish.parse(input).message, live: true }, options),
    },
    fetch_site: {
      description:
        `Read a page or API response from ${context.repository}'s own live site: its production address or a ` +
        "preview link Workers Builds reported, with the site's current content, including copy kept in its " +
        'database or CMS and served by its pages or JSON endpoints. Read-only GET; text formats only; long ' +
        'responses come in pages.',
      inputSchema: MODEL_TOOL_INPUT_SCHEMAS.fetch_site,
      execute: (input, options) => context.fetchSite(MODEL_TOOL_INPUT_SCHEMAS.fetch_site.parse(input), options),
    },
  } satisfies Record<LinkedProjectModelToolName, Tool>;
}
