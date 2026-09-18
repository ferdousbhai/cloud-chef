import { describe, expect, it } from 'vitest';
import { WORK_DIR } from '../constants.js';
import { getAbsolutePath, getRelativePath } from './workDir.js';

const WORK_DIR_NAMELESS = `${WORK_DIR}-backup`;

describe('work directory paths', () => {
  it('keeps workspace root and child paths absolute', () => {
    expect(getAbsolutePath(WORK_DIR)).toBe(WORK_DIR);
    expect(getAbsolutePath(`${WORK_DIR}/src/index.ts`)).toBe(`${WORK_DIR}/src/index.ts`);
    expect(getAbsolutePath('src/index.ts')).toBe(`${WORK_DIR}/src/index.ts`);
  });

  it('converts only workspace root and child paths to relative paths', () => {
    expect(getRelativePath(WORK_DIR)).toBe('');
    expect(getRelativePath(`${WORK_DIR}/src/index.ts`)).toBe('src/index.ts');
    expect(getRelativePath(`${WORK_DIR_NAMELESS}/src/index.ts`)).toBe(`${WORK_DIR_NAMELESS}/src/index.ts`);
  });
});
