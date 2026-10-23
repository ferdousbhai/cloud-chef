import type { CloudChefToolResult } from 'cloudchef-agent/tool-result';
import { MODEL_TOOL_INPUT_SCHEMAS, type AppProjectModelToolName } from 'cloudchef-agent/model-tool-inputs';
import type { Tool } from 'cloudchef-agent/tool';

/** A turn working on a CloudChef app, whose history is the commits on main of its own repository. */
export type AppProjectModelToolContext = {
  /** Commits the workspace's current files to main, unless main already has exactly them. */
  commit(input: { message: string }): Promise<CloudChefToolResult>;
};

/** The tools a CloudChef app's turn adds. */
export function appProjectModelTools(context: AppProjectModelToolContext) {
  return {
    commit: {
      description:
        "Commit the project's current files to main of its repository, with your message. The commits on main are " +
        'the history the user sees, reverts to, forks, clones and downloads. Publishing does not commit.',
      inputSchema: MODEL_TOOL_INPUT_SCHEMAS.commit,
      execute: (input) => context.commit(MODEL_TOOL_INPUT_SCHEMAS.commit.parse(input)),
    },
  } satisfies Record<AppProjectModelToolName, Tool>;
}
