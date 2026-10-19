import type { CloudChefToolResult } from 'cloudchef-agent/tool-result';
import { MODEL_TOOL_INPUT_SCHEMAS, type LinkedProjectModelToolName } from 'cloudchef-agent/model-tool-inputs';
import type { Tool } from 'cloudchef-agent/tool';

/**
 * A turn working on an organization's GitHub project. Its changes go back to GitHub, and the
 * repository's own pipeline (Workers Builds, typically) previews and deploys them.
 */
export type LinkedProjectModelToolContext = {
  repository: string;
  defaultBranch: string;
  /** Commits the validated workspace to the member's branch; `live` also merges it into the default branch. */
  publish(
    input: { message: string; live: boolean },
    options: { abortSignal?: AbortSignal },
  ): Promise<CloudChefToolResult>;
};

/** The tools a GitHub project's turn adds. */
export function linkedProjectModelTools(context: LinkedProjectModelToolContext) {
  return {
    publish_preview: {
      description:
        `Commit the validated workspace to your own branch of ${context.repository} on GitHub. Its pipeline builds ` +
        'the branch and posts a preview link, which this tool waits for and returns. Run validate first; call this ' +
        'when the user should see the change before it goes live.',
      inputSchema: MODEL_TOOL_INPUT_SCHEMAS.publish_preview,
      execute: (input, options) =>
        context.publish(
          { message: MODEL_TOOL_INPUT_SCHEMAS.publish_preview.parse(input).message, live: false },
          options,
        ),
    },
    publish: {
      description:
        `Put the validated workspace live: commit it and merge it into ${context.defaultBranch} of ` +
        `${context.repository}, which the repository's pipeline deploys to production. Run validate first, and ` +
        'publish only when the user asks for the change to go live.',
      inputSchema: MODEL_TOOL_INPUT_SCHEMAS.publish,
      execute: (input, options) =>
        context.publish({ message: MODEL_TOOL_INPUT_SCHEMAS.publish.parse(input).message, live: true }, options),
    },
  } satisfies Record<LinkedProjectModelToolName, Tool>;
}
