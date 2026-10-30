import { describe, expect, it } from 'vitest';
import { createContainerDirectoryCommand } from './isolated-project';

describe('isolated project command', () => {
  it('enters a quoted native directory from a valid workspace cwd', () => {
    expect(
      createContainerDirectoryCommand({
        directory: '/tmp/cloudchef projects/validation-id',
        command: 'pnpm run build',
      }),
    ).toBe("cd '/tmp/cloudchef projects/validation-id' &&\npnpm run build");
  });
});
