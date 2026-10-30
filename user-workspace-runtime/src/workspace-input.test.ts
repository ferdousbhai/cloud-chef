import { describe, expect, it } from 'vitest';
import { canonicalAbsolutePath, projectPath, requireWorkspaceFileEncoding } from './workspace-input';

describe('workspace input validation', () => {
  it('defaults an omitted file encoding but rejects invalid explicit values', () => {
    expect(requireWorkspaceFileEncoding(undefined)).toBe('utf8');
    expect(requireWorkspaceFileEncoding('utf8')).toBe('utf8');
    expect(requireWorkspaceFileEncoding('base64')).toBe('base64');
    expect(() => requireWorkspaceFileEncoding('binary')).toThrow('Invalid workspace file encoding');
  });

  it('spells a workspace path one way, so `.` segments cannot hide the project root', () => {
    expect(canonicalAbsolutePath('/home/project/./src//app.ts/')).toBe('/home/project/src/app.ts');
    expect(canonicalAbsolutePath('\\home\\project\\src')).toBe('/home/project/src');
    expect(canonicalAbsolutePath('/home/project/.')).toBe('/home/project');
    expect(canonicalAbsolutePath('/')).toBe('/');
    expect(() => canonicalAbsolutePath('/home/project/../etc')).toThrow('Invalid absolute workspace path');
    expect(() => canonicalAbsolutePath('home/project')).toThrow('Invalid absolute workspace path');
    expect(() => canonicalAbsolutePath('/home/project/a\0b')).toThrow('Invalid absolute workspace path');
  });

  it('refuses the project root, however it is spelled, where a file inside it is named', () => {
    const root = '/home/project';
    for (const spelling of ['/home/project/.', '/home/project/./', '/home/project/./.', '/home/project//']) {
      expect(() => projectPath(canonicalAbsolutePath(spelling), root, false)).toThrow('is the project directory');
      expect(projectPath(canonicalAbsolutePath(spelling), root, true)).toBe(root);
    }
    expect(projectPath(canonicalAbsolutePath('/home/project/./src'), root, false)).toBe('/home/project/src');
    expect(() => projectPath(canonicalAbsolutePath('/home/projects/x'), root, false)).toThrow('Path must be under');
  });
});
