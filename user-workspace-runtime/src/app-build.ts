import { z } from 'zod';
import {
  deploymentProjectProfileFromProject,
  type DeploymentProjectProfile,
} from '../../app/lib/.server/cloudflare/deployment-project-profile';
import {
  DEPLOYMENT_ASSETS_RUN_WORKER_FIRST,
  DEPLOYMENT_COMPATIBILITY_DATE,
  DEPLOYMENT_COMPATIBILITY_FLAGS,
  DEPLOYMENT_OBSERVABILITY,
  DEPLOYMENT_SECURITY_CLEANUP_CRON,
} from '../../app/lib/.server/cloudflare/deployment-runtime-policy';
import { isCloudChefResourceName } from '../../app/lib/.server/cloudflare/deploy-api-policy';
import type { D1MigrationChangedError } from '../../app/lib/.server/cloudflare/user-account-api';
import { sha256Hex } from '../../app/lib/hex-digest';
import {
  CF_BUILT_ASSETS_DIR,
  CF_BUILT_WORKER_MODULE,
  CLOUDFLARE_PROJECT_FILE,
  parseCloudflareProjectText,
} from '../../template/scripts/lib/cloudflare-project.mjs';

/**
 * A CloudChef app (a project made from CloudChef's starter, with a `cloudflare.project.json`) built and deployed by
 * the ProjectBuilder in app mode. The project's own `cloudflare.project.json` says only which capabilities it uses
 * (a database, file storage, a cache, the Agent); CloudChef makes those resources in the account, applies the
 * databases' migrations, and writes the Wrangler config the deploy uses from its own trusted settings, so nothing of
 * the project's configuration decides what is deployed or how.
 */

export { CLOUDFLARE_PROJECT_FILE };

/** Where the starter's build (`pnpm run build`, the Cloudflare Vite plugin) leaves the Worker and its assets. */
export const APP_BUILT_WORKER_MODULE = CF_BUILT_WORKER_MODULE;
const APP_BUILT_BUNDLE_DIR = CF_BUILT_WORKER_MODULE.slice(0, CF_BUILT_WORKER_MODULE.lastIndexOf('/'));
const APP_BUILT_ASSETS_DIR = CF_BUILT_ASSETS_DIR;

/** The folders whose `NNNN_name.sql` files are the app's D1 migrations, by binding. */
export const APP_MIGRATION_DIRECTORIES = { DB: 'migrations', AGENT_SECURITY_DB: 'agent-security-migrations' } as const;
const MIGRATION_NAME = /^\d{4}_[a-zA-Z0-9._-]+\.sql$/;

const APP_AGENT_CLASS_NAME = 'AppAgent';
/** How much of an applied migration's SQL a refusal quotes. */
const MIGRATION_SQL_QUOTE_LIMIT = 2_000;

/**
 * The capabilities an app's `cloudflare.project.json` (and package.json's `cloudchef.projectType`) declare, or why
 * they can't be read.
 */
const appPackageSchema = z.looseObject({
  cloudchef: z.looseObject({ projectType: z.enum(['web_app', 'worker']).optional() }).optional(),
});

export function appProfile(files: {
  projectFile: string;
  packageJson: string;
}): { profile: DeploymentProjectProfile } | { reason: string } {
  const parsed = parseCloudflareProjectText(files.projectFile);
  if (parsed.errors.length > 0) {
    return { reason: `${CLOUDFLARE_PROJECT_FILE} isn’t right: ${parsed.errors.join(' ')}` };
  }
  let manifest: z.infer<typeof appPackageSchema>;
  try {
    const read = appPackageSchema.safeParse(JSON.parse(files.packageJson));
    if (!read.success) {
      return { reason: 'package.json’s cloudchef.projectType must be "web_app" or "worker".' };
    }
    manifest = read.data;
  } catch {
    return { reason: 'CloudChef couldn’t read package.json.' };
  }
  try {
    return {
      profile: deploymentProjectProfileFromProject(parsed.project, manifest.cloudchef?.projectType ?? 'web_app'),
    };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : 'CloudChef couldn’t read the app’s settings.' };
  }
}

/** The account resources an app's Worker uses, by binding. */
export type AppResources = {
  DB?: { id: string; name: string };
  AGENT_SECURITY_DB?: { id: string; name: string };
  APP_STORAGE?: { name: string };
  APP_CACHE?: { id: string };
};

/**
 * The names of an app's databases, bucket and namespace: its Worker's name, a word for what each holds, and a tag
 * from the project's id, so they are the project's own whatever else the account holds, the same at every deploy
 * (the Worker's name is kept once chosen), and never one of CloudChef's own names.
 */
export async function appResourceNames(workerName: string, projectId: string) {
  const tag = (await sha256Hex(`cloudchef-app-resources:${projectId}`)).slice(0, 6);
  const base = workerName.slice(0, 40).replace(/-+$/, '');
  const name = (word: string) => {
    const value = `${base}-${word}-${tag}`;
    if (isCloudChefResourceName(value)) {
      throw new Error('An app’s resources can’t take one of CloudChef’s own names.');
    }
    return value;
  };
  return {
    DB: name('db'),
    AGENT_SECURITY_DB: name('agent'),
    APP_STORAGE: name('files'),
    APP_CACHE: name('cache'),
  };
}

/** The app's migrations at a commit, by binding, in the order they apply: `NNNN_name.sql` files of each folder. */
export function appMigrationFiles(files: readonly { path: string; oid: string }[], profile: DeploymentProjectProfile) {
  const inFolder = (folder: string) =>
    files
      .filter((file) => file.path.startsWith(`${folder}/`) && !file.path.slice(folder.length + 1).includes('/'))
      .map((file) => ({ name: file.path.slice(folder.length + 1), oid: file.oid }))
      .filter((file) => MIGRATION_NAME.test(file.name))
      .sort((left, right) => left.name.localeCompare(right.name));
  return {
    DB: profile.bindings.d1 ? inFolder(APP_MIGRATION_DIRECTORIES.DB) : [],
    AGENT_SECURITY_DB: profile.bindings.appAgent ? inFolder(APP_MIGRATION_DIRECTORIES.AGENT_SECURITY_DB) : [],
  };
}

/** The parts of a Wrangler config an app's deploy sets. */
type AppWranglerConfig = {
  name: string;
  main: string;
  base_dir: string;
  no_bundle: true;
  find_additional_modules: true;
  rules: { type: 'ESModule' | 'CompiledWasm'; globs: string[] }[];
  compatibility_date: string;
  compatibility_flags: string[];
  workers_dev: true;
  preview_urls: true;
  observability: typeof DEPLOYMENT_OBSERVABILITY;
  assets?: { directory: string; binding: 'ASSETS'; run_worker_first: string[] };
  d1_databases?: { binding: 'DB' | 'AGENT_SECURITY_DB'; database_name: string; database_id: string }[];
  r2_buckets?: { binding: 'APP_STORAGE'; bucket_name: string }[];
  kv_namespaces?: { binding: 'APP_CACHE'; id: string }[];
  ai?: { binding: 'AI' };
  durable_objects?: { bindings: { name: string; class_name: string }[] };
  migrations?: { tag: string; new_sqlite_classes: string[] }[];
  triggers: { crons: string[] };
};

/**
 * The Wrangler config an app deploys with, written by CloudChef in the work folder: the built Worker as it is
 * (Wrangler bundles nothing), its assets, the bindings to the resources CloudChef made, and CloudChef's own
 * compatibility, observability and address settings. A branch's preview is uploaded as a version of the same Worker,
 * so preview addresses are on.
 */
export function trustedAppWranglerConfig(args: {
  workerName: string;
  profile: DeploymentProjectProfile;
  resources: AppResources;
}): AppWranglerConfig {
  const { profile, resources } = args;
  const config: AppWranglerConfig = {
    name: args.workerName,
    main: APP_BUILT_WORKER_MODULE,
    base_dir: APP_BUILT_BUNDLE_DIR,
    no_bundle: true,
    find_additional_modules: true,
    rules: [
      { type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] },
      { type: 'CompiledWasm', globs: ['**/*.wasm'] },
    ],
    compatibility_date: DEPLOYMENT_COMPATIBILITY_DATE,
    compatibility_flags: [...DEPLOYMENT_COMPATIBILITY_FLAGS],
    workers_dev: true,
    preview_urls: true,
    observability: DEPLOYMENT_OBSERVABILITY,
    triggers: { crons: [] },
  };
  if (profile.type === 'web_app' && profile.bindings.assets) {
    config.assets = {
      directory: APP_BUILT_ASSETS_DIR,
      binding: 'ASSETS',
      run_worker_first: [...DEPLOYMENT_ASSETS_RUN_WORKER_FIRST],
    };
  }
  const databases = (['DB', 'AGENT_SECURITY_DB'] as const).flatMap((binding) => {
    const database = resources[binding];
    return database ? [{ binding, database_name: database.name, database_id: database.id }] : [];
  });
  if (databases.length > 0) {
    config.d1_databases = databases;
  }
  if (resources.APP_STORAGE) {
    config.r2_buckets = [{ binding: 'APP_STORAGE', bucket_name: resources.APP_STORAGE.name }];
  }
  if (resources.APP_CACHE) {
    config.kv_namespaces = [{ binding: 'APP_CACHE', id: resources.APP_CACHE.id }];
  }
  if (profile.bindings.ai) {
    config.ai = { binding: 'AI' };
  }
  if (profile.bindings.appAgent) {
    config.durable_objects = { bindings: [{ name: APP_AGENT_CLASS_NAME, class_name: APP_AGENT_CLASS_NAME }] };
    config.migrations = [{ tag: 'v1', new_sqlite_classes: [APP_AGENT_CLASS_NAME] }];
    config.triggers = { crons: [DEPLOYMENT_SECURITY_CLEANUP_CRON] };
  }
  return config;
}

/**
 * Why an app can't be deployed without its Agent: its Worker holds the app's Agent data (AppAgent Durable Objects),
 * and Cloudflare removes a Durable Object class only by deleting it with every object and its data, which CloudChef
 * never does to deploy an app. Null when the deploy keeps the Agent or the Worker has none.
 */
export function agentRemovalRefusal(
  profile: DeploymentProjectProfile,
  workerClasses: readonly string[],
): string | null {
  if (profile.bindings.appAgent || !workerClasses.includes(APP_AGENT_CLASS_NAME)) {
    return null;
  }
  return (
    'The Agent can’t be removed from this published app: its Worker holds the app’s Agent data (AppAgent Durable ' +
    'Objects), and Cloudflare removes them only by deleting that data, which CloudChef won’t do. Restore the Agent ' +
    '(pnpm run agent:enable) and publish again.'
  );
}

/**
 * The way out of a changed migration: put the change in a new one, and give the applied one back its applied
 * contents, quoted when the database recorded them. Deleting the file is the other way back, fit only for one that
 * holds nothing a new database needs, like the starter's placeholder.
 */
export function migrationChangedMessage(error: D1MigrationChangedError): string {
  const name = error.migrationName;
  const applied =
    error.appliedSql === null
      ? ''
      : ` It was applied as:\n${error.appliedSql.slice(0, MIGRATION_SQL_QUOTE_LIMIT)}${
          error.appliedSql.length > MIGRATION_SQL_QUOTE_LIMIT ? '\n[truncated]' : ''
        }`;
  return (
    `The migration ${name} was already applied to the live database with different contents, and an applied migration never runs again. ` +
    `Put the change in a new migration numbered after the last one, and restore ${name} exactly as it was applied, ` +
    `or delete ${name} if it holds no schema a new database needs (as the starter's 0001_app_data.sql placeholder does).${applied}`
  );
}
