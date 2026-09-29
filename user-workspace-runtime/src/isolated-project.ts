import { shellQuote } from './shell-quote';

export const ISOLATED_PROJECT_ROOT = '/tmp/cloudchef-projects';

export function createContainerDirectoryCommand(args: { directory: string; command: string }): string {
  return `cd ${shellQuote(args.directory)} &&\n${args.command}`;
}

export function relativeIsolatedPath(root: string, absolutePath: string): string {
  const normalizedRoot = root.replace(/\/+$/, '');
  if (!absolutePath.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`Isolated file is outside its expected root: ${absolutePath}`);
  }
  return absolutePath.slice(normalizedRoot.length + 1);
}
