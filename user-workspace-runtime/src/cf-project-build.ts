import { z } from 'zod';
import { CF_BUILD_OUTPUT_VERSIONS, cfBuildOutput } from '../../template/scripts/lib/cloudflare-project.mjs';
import { WORK_DIR } from './project-builder-scripts';
import { shellQuote } from './shell-quote';

/**
 * A project configured for the `cf` CLI (a `cloudflare.config.ts` and no Wrangler config), built and deployed by the
 * ProjectBuilder. Its own `build` script runs `cf build`, which leaves the Worker, its assets and its settings as
 * Build Output (`.cloudflare/output/<version>/workers/default/`, `v1` from `cf` 1.0.0-rc on and `v0` before it; the
 * Worker's settings are written the same in both). Nothing of the project runs after that: Cloudflare's own
 * converter (`@cloudflare/config`, CloudChef's pinned copy) turns those settings into a Wrangler config, and
 * CloudChef's Wrangler deploys the built Worker as it is, as it does every other project.
 */

/**
 * The converter. `cf` 1.0.0-rc carries a later one (1.0.0-rc.4), which no longer exports the schema this reads Build
 * Output with (`OutputWorkerSchema`); this one reads what the release candidates build as it is.
 */
export const CF_CONFIG_VERSION = '0.28.1';
const CF_CONFIG_ROOT = '/opt/cloudchef/cf-config';
const CF_CONFIG_MODULE = `${CF_CONFIG_ROOT}/node_modules/@cloudflare/config/dist/index.mjs`;

export type BuildOutputVersion = (typeof CF_BUILD_OUTPUT_VERSIONS)[number];
/** Where a Worker is looked for, as a build that left none is told: either version's folder. */
const BUILT_WORKER_CONFIG_PATTERN = cfBuildOutput(`{${CF_BUILD_OUTPUT_VERSIONS.join(',')}}`).workerConfig;

/**
 * Removes the file that marks a folder as Build Output, of either version. Wrangler refuses to deploy beside it,
 * lest its own config name another Worker than the one `cf` built; the config CloudChef's Wrangler deploys with is
 * made from that very output (or, for a CloudChef app, by CloudChef), so there is no other to disagree with.
 */
export function forgetBuildOutputMarker(): string {
  return `rm -f ${CF_BUILD_OUTPUT_VERSIONS.map((version) => shellQuote(`${WORK_DIR}/${cfBuildOutput(version).marker}`)).join(' ')}`;
}

/**
 * Bash that sets `$version` to the one Build Output version in which the build left `file` (a key of
 * `cfBuildOutput`), and otherwise prints `no-worker` or `several-versions` and ends: output of two versions side
 * by side doesn't say which is the build's, and `cf` refuses it too.
 */
export function builtVersionLines(file: 'workerConfig' | 'workerModule'): string[] {
  return [
    'version=',
    ...CF_BUILD_OUTPUT_VERSIONS.map(
      (version) =>
        `if [ -f ${shellQuote(`${WORK_DIR}/${cfBuildOutput(version)[file]}`)} ]; then [ -z "$version" ] || { echo several-versions; exit 0; }; version=${version}; fi`,
    ),
    '[ -n "$version" ] || { echo no-worker; exit 0; }',
  ];
}

/**
 * Reads the built Worker's settings and prints them as a Wrangler config (`{ config, mainModule }`), or why they
 * can't be read (`{ error }`). Only JSON is read: nothing of the project is imported or run. Arguments: the
 * converter's module, the built `worker.config.json`.
 */
const CF_CONVERT_SCRIPT = `
import { readFileSync } from 'node:fs';
const [modulePath, configPath] = process.argv.slice(-2);
const { OutputWorkerSchema, resolveAndParseConfig, convertToWranglerConfig } = await import(modulePath);
const say = (value) => process.stdout.write(JSON.stringify(value));
const issues = (error) => error.issues.slice(0, 5).map((issue) => issue.path.join('.') + ': ' + issue.message).join('; ');
let raw;
try {
  raw = JSON.parse(readFileSync(configPath, 'utf8'));
} catch {
  say({ error: 'it is not JSON' });
  process.exit(0);
}
const built = OutputWorkerSchema.safeParse(raw);
if (!built.success) {
  say({ error: issues(built.error) });
  process.exit(0);
}
const mainModule = built.data.manifest?.mainModule;
if (typeof mainModule !== 'string' || mainModule === '') {
  say({ error: 'it names no main module' });
  process.exit(0);
}
const { manifest, ...worker } = raw;
const parsed = await resolveAndParseConfig(
  { worker: { ...worker, entrypoint: './' + mainModule } },
  { mode: 'production', isPreview: false },
);
if (!parsed.success) {
  say({ error: issues(parsed.error) });
  process.exit(0);
}
say({ config: convertToWranglerConfig(parsed.data), mainModule });
`;

/**
 * Checks the build left one Worker and nothing else to deploy, then converts its settings. Run by bash as root, once
 * the build's processes are stopped; prints `CF_CONVERT_SCRIPT`'s answer and, on a last line, whether the build left
 * static assets and a `migrations` folder, and which Build Output version it is.
 */
export function cfConvertCommand(modulePath = CF_CONFIG_MODULE, installRoot: string | null = CF_CONFIG_ROOT): string {
  // The paths of the version found, with `$version` left for bash to fill in.
  const built = cfBuildOutput('$version');
  const inWorkFolder = (path: string) => `"${WORK_DIR}/${path}"`;
  return [
    'set -eu',
    ...builtVersionLines('workerConfig'),
    `others="$(ls -A ${inWorkFolder(built.workersDir)} | grep -vx default || true)"`,
    `containers="$(ls -A ${inWorkFolder(built.containersDir)} 2>/dev/null || true)"`,
    '[ -z "$others$containers" ] || { echo several; exit 0; }',
    ...(installRoot
      ? [
          `[ -f ${shellQuote(modulePath)} ] || npm install --prefix ${shellQuote(installRoot)} @cloudflare/config@${CF_CONFIG_VERSION} --ignore-scripts --no-audit --no-fund --loglevel=error >&2`,
        ]
      : []),
    `node --input-type=module -e ${shellQuote(CF_CONVERT_SCRIPT)} ${shellQuote(modulePath)} ${inWorkFolder(built.workerConfig)}`,
    'echo',
    `assets=no; [ -n "$(ls -A ${inWorkFolder(built.assetsDir)} 2>/dev/null || true)" ] && assets=yes`,
    `migrations=no; [ -d ${shellQuote(`${WORK_DIR}/migrations`)} ] && migrations=yes`,
    'echo "assets=$assets migrations=$migrations version=$version"',
  ].join('\n');
}

const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Why a build that left Build Output of two versions is not published. */
export const SEVERAL_VERSIONS_REASON =
  `The build left Build Output of more than one version (${CF_BUILD_OUTPUT_VERSIONS.map((version) => cfBuildOutput(version).root).join(', ')}), ` +
  'so CloudChef can’t tell which is the build’s. Remove the one the project’s cf doesn’t write.';

const convertedSchema = z.union([
  z.object({ error: z.string() }),
  z.object({
    mainModule: z.string().min(1),
    config: z.looseObject({
      name: z.string().optional(),
      assets: z.record(z.string(), z.unknown()).optional(),
      routes: z.array(z.unknown()).optional(),
      d1_databases: z.array(z.looseObject({ binding: z.string(), database_name: z.string().optional() })).optional(),
    }),
  }),
]);

/** The converted settings as they come, with the built Worker and its assets as CloudChef names them. */
type CfDeployConfig = Omit<Extract<z.infer<typeof convertedSchema>, { config: unknown }>['config'], 'routes'> & {
  name: string;
  main: string;
  base_dir: string;
  no_bundle: true;
  find_additional_modules: true;
  rules: { type: 'ESModule' | 'CompiledWasm'; globs: string[] }[];
};

/** What a `cf` project's build comes to: the Wrangler config its deploy uses, or why it can't be deployed. */
export type CfProjectDeploy =
  | { reason: string; stage: 'build' | 'config' }
  | {
      /** The Wrangler config, written at the top of the work folder: its paths are relative to it. */
      config: CfDeployConfig;
      workerName: string;
      /** The D1 database whose `migrations` folder applies before a deploy of main. */
      migrations: { binding: string; databaseName: string }[];
      /** What the project's log is told of the settings a deploy leaves alone. */
      notes: string[];
    };

/**
 * The Wrangler config a `cf` project deploys with, from `cfConvertCommand`'s output: the converted settings, with the
 * built Worker as it is (Wrangler bundles nothing) and its assets. Domains and routes are left out: publishing never
 * changes which addresses reach a Worker, so the ones attached to it stay. The `migrations` folder applies to the
 * project's database when it has just one, which is all `cf d1 migrations apply --dir migrations` can mean.
 */
export function cfProjectDeploy(output: string): CfProjectDeploy {
  const lines = output.trim().split('\n');
  if (lines[0] === 'no-worker') {
    return {
      stage: 'build',
      reason: `The build didn’t leave a Worker (${BUILT_WORKER_CONFIG_PATTERN}). Its build script must run cf build.`,
    };
  }
  if (lines[0] === 'several-versions') {
    return { stage: 'config', reason: SEVERAL_VERSIONS_REASON };
  }
  if (lines[0] === 'several') {
    return {
      stage: 'config',
      reason: 'The build left more than one Worker, or a container, and CloudChef publishes one Worker per project.',
    };
  }
  const facts = lines.at(-1) ?? '';
  const version = CF_BUILD_OUTPUT_VERSIONS.find((candidate) => facts.endsWith(` version=${candidate}`));
  if (!version) {
    return { stage: 'config', reason: 'CloudChef couldn’t read the settings the build left for its Worker.' };
  }
  const built = cfBuildOutput(version);
  let converted: z.infer<typeof convertedSchema>;
  try {
    converted = convertedSchema.parse(JSON.parse(lines.slice(0, -1).join('\n')));
  } catch {
    return { stage: 'config', reason: 'CloudChef couldn’t read the settings the build left for its Worker.' };
  }
  if ('error' in converted) {
    return {
      stage: 'config',
      reason: `CloudChef couldn’t read the settings the build left for its Worker: ${converted.error.slice(0, 400)}.`,
    };
  }
  const { routes, route: _route, build: _build, assets, ...settings } = converted.config;
  const workerName = settings.name;
  if (!workerName || !WORKER_NAME.test(workerName)) {
    return {
      stage: 'config',
      reason: 'cloudflare.config.ts needs a name for the Worker: lowercase letters, digits and dashes.',
    };
  }
  const config: CfDeployConfig = {
    ...settings,
    name: workerName,
    main: `${built.bundleDir}/${converted.mainModule}`,
    base_dir: built.bundleDir,
    no_bundle: true,
    find_additional_modules: true,
    rules: [
      { type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] },
      { type: 'CompiledWasm', globs: ['**/*.wasm'] },
    ],
  };
  if (facts.includes('assets=yes')) {
    config.assets = { ...assets, directory: built.assetsDir };
  }
  const notes: string[] = [];
  if (routes && routes.length > 0) {
    notes.push(
      'The domains and routes in cloudflare.config.ts are not changed by publishing: the ones attached to the ' +
        'Worker stay as they are. Attach or remove one with cf.',
    );
  }
  const databases = (settings.d1_databases ?? []).flatMap((database) =>
    database.database_name ? [{ binding: database.binding, databaseName: database.database_name }] : [],
  );
  let migrations: { binding: string; databaseName: string }[] = [];
  if (facts.includes('migrations=yes')) {
    if (databases.length === 1 && (settings.d1_databases ?? []).length === 1) {
      migrations = databases;
    } else {
      notes.push(
        'The migrations folder was not applied: publishing applies it only when the project has exactly one D1 ' +
          'database, named in cloudflare.config.ts.',
      );
    }
  }
  return { config, workerName, migrations, notes };
}
