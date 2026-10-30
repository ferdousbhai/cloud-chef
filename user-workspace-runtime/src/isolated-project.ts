import { shellQuote } from './shell-quote';

export const ISOLATED_PROJECT_ROOT = '/tmp/cloudchef-projects';

export function createContainerDirectoryCommand(args: { directory: string; command: string }): string {
  return `cd ${shellQuote(args.directory)} &&\n${args.command}`;
}
