import pathBrowserify from 'path-browserify';

export const path = {
  join: (...paths: string[]): string => pathBrowserify.join(...paths),
  relative: (from: string, to: string): string => pathBrowserify.relative(from, to),
  normalize: (path: string): string => pathBrowserify.normalize(path),
} as const;
