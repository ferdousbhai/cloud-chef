import { describe, expect, it } from 'vitest';
import { createContainerDirectoryCommand, relativeIsolatedPath } from './isolated-project';

describe('isolated project command', () => {
  it('enters a quoted native directory from a valid workspace cwd', () => {
    expect(
      createContainerDirectoryCommand({
        directory: '/tmp/cloudchef projects/validation-id',
        command: 'pnpm run build',
      }),
    ).toBe("cd '/tmp/cloudchef projects/validation-id' &&\npnpm run build");
  });

  it('derives artifact paths from the requested root, not transport metadata', () => {
    expect(
      relativeIsolatedPath(
        '/tmp/cloudchef-projects/deployment-id/.cloudchef-artifact',
        '/tmp/cloudchef-projects/deployment-id/.cloudchef-artifact/index.js',
      ),
    ).toBe('index.js');
    expect(() =>
      relativeIsolatedPath(
        '/tmp/cloudchef-projects/deployment-id/.cloudchef-artifact',
        '/tmp/cloudchef-projects/deployment-id/elsewhere/index.js',
      ),
    ).toThrow(/outside its expected root/i);
  });
});
