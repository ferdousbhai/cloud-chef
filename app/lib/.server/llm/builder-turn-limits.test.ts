import { describe, expect, it } from 'vitest';
import { isWorkspaceReadOnlyToolName, MODEL_TOOL_NAMES } from 'cloudchef-agent/model-tool-inputs';

const WORKSPACE_READ_ONLY_TOOL_NAMES = MODEL_TOOL_NAMES.filter(isWorkspaceReadOnlyToolName);
import {
  BUILDER_MUTATION_TOOL_TIMEOUT_MS,
  BUILDER_TOOL_DEADLINES_MS,
  BuilderToolDeadlineError,
} from './builder-turn-limits';

describe('builder tool deadlines', () => {
  it('never gives a VFS-only tool a container-sized deadline', () => {
    for (const tool of WORKSPACE_READ_ONLY_TOOL_NAMES) {
      expect(BUILDER_TOOL_DEADLINES_MS[tool]).toBeLessThan(BUILDER_MUTATION_TOOL_TIMEOUT_MS);
    }
  });

  it('names the stopped tool and its deadline in words the model can act on', () => {
    expect(new BuilderToolDeadlineError('exec').message).toBe('exec did not finish within 35 minutes and was stopped.');
    expect(new BuilderToolDeadlineError('read').message).toBe('read did not finish within 2 minutes and was stopped.');
  });
});
