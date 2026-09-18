import { shellQuote } from './shell-quote';

export const ISOLATED_PROJECT_ROOT = '/tmp/cloudchef-projects';

type DeploymentConfigPaths = {
  main: string;
  assets?: { directory: string };
  d1_databases?: Array<{ migrations_dir: string }>;
};

export function createContainerDirectoryCommand(args: { directory: string; command: string }): string {
  return `cd ${shellQuote(args.directory)} &&\n${args.command}`;
}

export function rebaseDeploymentConfigPaths<T extends DeploymentConfigPaths>(
  config: T,
  args: { projectRoot: string; isolatedRoot: string },
): T {
  const rebase = (path: string): string => {
    const suffix = path.slice(args.projectRoot.length);
    if (!path.startsWith(`${args.projectRoot}/`) || !suffix.startsWith('/')) {
      throw new Error(`Deployment path is outside the project root: ${path}`);
    }
    return `${args.isolatedRoot}${suffix}`;
  };

  const rebased: T = { ...config, main: rebase(config.main) };
  if (config.assets) {
    rebased.assets = { ...config.assets, directory: rebase(config.assets.directory) };
  }
  if (config.d1_databases) {
    rebased.d1_databases = config.d1_databases.map((database) => ({
      ...database,
      migrations_dir: rebase(database.migrations_dir),
    }));
  }
  return rebased;
}

export function relativeIsolatedPath(root: string, absolutePath: string): string {
  const normalizedRoot = root.replace(/\/+$/, '');
  if (!absolutePath.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`Isolated file is outside its expected root: ${absolutePath}`);
  }
  return absolutePath.slice(normalizedRoot.length + 1);
}
