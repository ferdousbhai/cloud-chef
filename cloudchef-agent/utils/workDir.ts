import { WORK_DIR } from '../constants.js';
import { path } from './path.js';

export type RelativePath = string & { __brand: 'RelativePath' };
export type AbsolutePath = string & { __brand: 'AbsolutePath' };

function isWorkDirPath(pathString: string) {
  return pathString === WORK_DIR || pathString.startsWith(`${WORK_DIR}/`);
}

export const getAbsolutePath = (pathString: string): AbsolutePath => {
  // SAFETY: sole constructor of the AbsolutePath brand; the result is rooted at WORK_DIR either way.
  return (isWorkDirPath(pathString) ? pathString : path.join(WORK_DIR, pathString)) as AbsolutePath;
};

export const getRelativePath = (pathString: string): RelativePath => {
  // SAFETY: sole constructor of the RelativePath brand; the result is stripped of the WORK_DIR prefix.
  return (isWorkDirPath(pathString) ? path.relative(WORK_DIR, pathString) : pathString) as RelativePath;
};
