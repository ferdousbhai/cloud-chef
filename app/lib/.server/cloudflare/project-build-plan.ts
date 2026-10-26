import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

/**
 * How CloudChef builds and deploys a commit of a project it deploys itself, worked out from the commit's own
 * files in the Worker (trusted), before anything runs: whether it can be deployed at all, the commands that
 * install and build it, the Worker it deploys as, and the D1 databases whose migrations apply first.
 */

/** The files at the root of a commit that decide how it builds. */
export const BUILD_PLAN_FILES = [
  'package.json',
  'wrangler.json',
  'wrangler.jsonc',
  'wrangler.toml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.yarnrc.yml',
  'bun.lock',
  'bun.lockb',
] as const;
type BuildPlanFile = (typeof BUILD_PLAN_FILES)[number];

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export type BuildPlan =
  | {
      deployable: true;
      packageManager: PackageManager;
      /** Run as the unprivileged build user, with no credential. */
      install: string;
      build: string | null;
      /** The Wrangler config's own `build.command`, run in the build step too, so deploy runs none. */
      configBuild: string | null;
      configFile: 'wrangler.json' | 'wrangler.jsonc' | 'wrangler.toml';
      /** The Worker the config names. */
      workerName: string;
      /** The D1 bindings with migrations, applied before the new code goes live. */
      migrations: { binding: string; databaseName: string }[];
    }
  | { deployable: false; reason: string };

const packageSchema = z.looseObject({
  packageManager: z.string().optional().catch(undefined),
  scripts: z.record(z.string(), z.string()).optional().catch(undefined),
});

const wranglerSchema = z.looseObject({
  name: z.string().optional().catch(undefined),
  build: z
    .looseObject({ command: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  d1_databases: z
    .array(
      z.looseObject({
        binding: z.string(),
        database_name: z.string().optional(),
        migrations_dir: z.string().optional(),
      }),
    )
    .optional()
    .catch(undefined),
});

/** A Worker name as Cloudflare allows them: lowercase letters, digits and dashes, starting with a letter or digit. */
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The plan for a commit, from the contents of whichever of `BUILD_PLAN_FILES` it has at its root. A commit without
 * a `package.json` or a Wrangler config naming its Worker is kept as code only, saying what it lacks.
 */
export function buildPlan(files: Partial<Record<BuildPlanFile, string>>): BuildPlan {
  const configFile = (['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'] as const).find((name) => files[name]);
  if (files['package.json'] === undefined || !configFile) {
    return {
      deployable: false,
      reason:
        'This project has no package.json and Wrangler config (wrangler.jsonc, wrangler.json or wrangler.toml) at ' +
        'its top level, so CloudChef can’t tell how to build and publish it.',
    };
  }
  let config: z.infer<typeof wranglerSchema>;
  let manifest: z.infer<typeof packageSchema>;
  try {
    const text = files[configFile] ?? '';
    config = wranglerSchema.parse(
      configFile === 'wrangler.toml' ? parseToml(text) : JSON.parse(withoutJsonComments(text)),
    );
    manifest = packageSchema.parse(JSON.parse(files['package.json']));
  } catch {
    return { deployable: false, reason: `CloudChef couldn’t read ${configFile} or package.json.` };
  }
  if (!config.name || !WORKER_NAME.test(config.name)) {
    return {
      deployable: false,
      reason: `${configFile} needs a name for the Worker: lowercase letters, digits and dashes.`,
    };
  }
  const packageManager = chosenPackageManager(files, manifest.packageManager);
  return {
    deployable: true,
    packageManager,
    install: installCommand(packageManager, files),
    build: manifest.scripts?.build ? `${packageManager} run build` : null,
    configBuild: config.build?.command?.trim() || null,
    configFile,
    workerName: config.name,
    migrations: (config.d1_databases ?? [])
      .filter((database) => database.database_name)
      .map((database) => ({ binding: database.binding, databaseName: database.database_name! })),
  };
}

function chosenPackageManager(
  files: Partial<Record<BuildPlanFile, string>>,
  declared: string | undefined,
): PackageManager {
  const named = declared?.split('@')[0];
  if (named === 'npm' || named === 'pnpm' || named === 'yarn' || named === 'bun') {
    return named;
  }
  if (files['pnpm-lock.yaml'] !== undefined) {
    return 'pnpm';
  }
  if (files['yarn.lock'] !== undefined) {
    return 'yarn';
  }
  if (files['bun.lock'] !== undefined || files['bun.lockb'] !== undefined) {
    return 'bun';
  }
  return 'npm';
}

/** Installs exactly what the lockfile says when there is one; without one, what package.json asks for. */
function installCommand(manager: PackageManager, files: Partial<Record<BuildPlanFile, string>>): string {
  switch (manager) {
    case 'pnpm':
      return files['pnpm-lock.yaml'] !== undefined ? 'pnpm install --frozen-lockfile' : 'pnpm install';
    case 'yarn':
      if (files['yarn.lock'] === undefined) {
        return 'yarn install';
      }
      return files['.yarnrc.yml'] !== undefined ? 'yarn install --immutable' : 'yarn install --frozen-lockfile';
    case 'bun':
      return files['bun.lock'] !== undefined || files['bun.lockb'] !== undefined
        ? 'bun install --frozen-lockfile'
        : 'bun install';
    case 'npm':
      break;
  }
  return files['package-lock.json'] !== undefined || files['npm-shrinkwrap.json'] !== undefined
    ? 'npm ci'
    : 'npm install';
}

/** JSON with comments and trailing commas, as Wrangler reads `wrangler.jsonc`, made plain JSON. */
export function withoutJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }
      out += '\n';
    } else if (char === '/' && next === '*') {
      index = text.indexOf('*/', index + 2);
      if (index === -1) {
        break;
      }
      index += 1;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** A name CloudChef's own Workers use, which a project never deploys as. */
export function isCloudChefWorkerName(name: string): boolean {
  return name === 'cloudchef' || name.startsWith('cloudchef-');
}

/** The Worker a deploy goes to, and whether that is a name made up because the config's was taken. */
type DeployWorker = { name: string; nameTaken: boolean };

/**
 * The Worker a project deploys as: the one it deployed as before, else the name its config gives while no Worker of
 * that name is in the account, else a free name made from it and the project's id. A name CloudChef's own Workers
 * use is never taken.
 */
export function deployWorkerName(args: {
  recorded: string | null;
  configName: string;
  projectId: string;
  /** Whether the account already has a Worker named `configName`. */
  configNameTaken: boolean;
}): DeployWorker {
  if (args.recorded) {
    return { name: args.recorded, nameTaken: false };
  }
  const reserved = isCloudChefWorkerName(args.configName);
  if (!args.configNameTaken && !reserved) {
    return { name: args.configName, nameTaken: false };
  }
  const suffix = args.projectId.replaceAll('-', '').slice(0, 4).toLowerCase();
  const base = reserved ? `site-${args.configName}` : args.configName;
  return { name: `${base.slice(0, 63 - suffix.length - 1)}-${suffix}`, nameTaken: true };
}
