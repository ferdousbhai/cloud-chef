import { z } from 'zod';
import { CF_BUILD_OUTPUT_VERSIONS, cfBuildOutput } from '../../template/scripts/lib/cloudflare-project.mjs';
import { builtVersionLines, SEVERAL_VERSIONS_REASON, type BuildOutputVersion } from './cf-project-build';
import { WORK_DIR } from './project-builder-scripts';
import { shellQuote } from './shell-quote';

/**
 * Publishing with the `cf` CLI instead of Wrangler, for the projects whose build leaves Build Output (a CloudChef
 * app and a `cf` project) in a runtime the control plane says publishes so (`project-builder-rollout.ts`). Once the
 * build's processes are stopped, the built Worker is moved out of the project into a folder of its own as Build
 * Output `v1`, with settings CloudChef wrote or checked, and CloudChef's own `cf` publishes it from there:
 * `cf d1 migrations apply <database id>`, `cf deploy --prebuilt --provision=false`, and
 * `cf workers versions create --prebuilt --preview-alias <alias>` for a branch. `cf` run inside the project would hand
 * over to the project's own copy of `cf` (it does for any `node_modules/cf` it finds from where it runs), so nothing
 * of the project is in that folder but what its build left to publish.
 */

/** CloudChef's own `cf`, which publishes; the project's own copy only ever builds. */
const CF_VERSION = '1.0.0-rc.6';
const CF_ROOT = '/opt/cloudchef/cf';
export const CF = `${CF_ROOT}/node_modules/.bin/cf`;
/** Where the built Worker is published from: nothing else of the project is here. */
export const PUBLISH_DIR = '/opt/cloudchef/publish';
const PUBLISHED = cfBuildOutput('v1');
/** The settings `cf` publishes the Worker with. */
export const PUBLISH_WORKER_CONFIG = `${PUBLISH_DIR}/${PUBLISHED.workerConfig}`;

/** Installs CloudChef's `cf` unless the container already has it. */
export function cfInstallLine(): string {
  return `[ -x ${CF} ] || npm install --prefix ${CF_ROOT} cf@${CF_VERSION} --ignore-scripts --no-audit --no-fund --loglevel=error`;
}

/**
 * Checks a `cf` project's build left one Worker and nothing else to publish, and prints its settings as the build
 * wrote them and, on a last line, whether the project has a `migrations` folder and which Build Output version it is.
 * Run by bash as root, once the build's processes are stopped.
 */
export function cfBuiltCommand(): string {
  const built = cfBuildOutput('$version');
  const inWorkFolder = (path: string) => `"${WORK_DIR}/${path}"`;
  return [
    'set -eu',
    ...builtVersionLines('workerConfig'),
    `others="$(ls -A ${inWorkFolder(built.workersDir)} | grep -vx default || true)"`,
    `containers="$(ls -A ${inWorkFolder(built.containersDir)} 2>/dev/null || true)"`,
    '[ -z "$others$containers" ] || { echo several; exit 0; }',
    `cat ${inWorkFolder(built.workerConfig)}`,
    'echo',
    `migrations=no; [ -d ${shellQuote(`${WORK_DIR}/migrations`)} ] && migrations=yes`,
    'echo "migrations=$migrations version=$version"',
  ].join('\n');
}

/**
 * Moves the Build Output of `version` out of the project to the folder it is published from, as `v1` whichever
 * version the build wrote (a Worker's settings, bundle and assets are the same in both; `cf` reads only `v1`), under a
 * marker CloudChef writes, and writes `workerConfig` as the Worker's settings when given. Run by bash as root.
 */
export function publishFolderCommand(version: BuildOutputVersion, workerConfig?: SealedWorkerConfig): string {
  const marker = {
    producer: { name: 'cloudchef', version: '1' },
    buildContext: { isPreview: false, mode: 'production' },
  };
  return [
    'set -eu',
    `rm -rf ${PUBLISH_DIR} ${WORK_DIR}/.wrangler/deploy`,
    `mkdir -p ${shellQuote(`${PUBLISH_DIR}/${PUBLISHED.root.slice(0, PUBLISHED.root.lastIndexOf('/'))}`)}`,
    `mv ${shellQuote(`${WORK_DIR}/${cfBuildOutput(version).root}`)} ${shellQuote(`${PUBLISH_DIR}/${PUBLISHED.root}`)}`,
    `printf %s ${shellQuote(JSON.stringify(marker))} > ${shellQuote(`${PUBLISH_DIR}/${PUBLISHED.marker}`)}`,
    ...(workerConfig === undefined ? [] : [writeWorkerConfigCommand(workerConfig)]),
  ].join('\n');
}

/** Writes the settings `cf` publishes the Worker with, in place of whatever is there. */
export function writeWorkerConfigCommand(workerConfig: SealedWorkerConfig): string {
  const bytes = new TextEncoder().encode(JSON.stringify(workerConfig));
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  const encoded = btoa(binary);
  return `rm -rf ${shellQuote(PUBLISH_WORKER_CONFIG)} && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(PUBLISH_WORKER_CONFIG)}`;
}

const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The parts of a built Worker's settings CloudChef reads; the rest goes to `cf` as the build wrote it. */
const builtWorkerSchema = z.looseObject({
  name: z.string().optional(),
  domains: z.array(z.unknown()).optional(),
  triggers: z.array(z.looseObject({ type: z.string() })).optional(),
  env: z
    .record(
      z.string(),
      z.looseObject({
        type: z.string(),
        id: z.string().optional(),
        name: z.string().optional(),
        worker: z.string().optional(),
      }),
    )
    .optional(),
});
type BuiltWorkerConfig = z.infer<typeof builtWorkerSchema>;
/** A Worker's settings as `cf` reads them from Build Output: the build's own, or the ones CloudChef writes an app. */
export type SealedWorkerConfig = BuiltWorkerConfig;

/** A D1 database whose migrations apply before a deploy of main, by the id `cf` applies them to. */
type CfMigration = { binding: string; databaseName: string; databaseId: string };

/** What a `cf` project's build comes to: the settings `cf` publishes it with, or why it can't be published. */
type CfBuiltWorker =
  | { reason: string; stage: 'build' | 'config' }
  | {
      /** The Worker's settings, without the addresses a publish never changes. */
      config: BuiltWorkerConfig;
      workerName: string;
      version: BuildOutputVersion;
      migrations: CfMigration[];
      /** What the project's log is told of the settings a publish leaves alone. */
      notes: string[];
    };

/**
 * The settings a `cf` project is published with, from `cfBuiltCommand`'s output: the build's own, without its
 * domains and routes (publishing never changes which addresses reach a Worker, so the ones attached to it stay: `cf`
 * neither reads nor writes a Worker's domains when its settings name none). The `migrations` folder applies to the
 * project's database when it has just one, by its id, which is how `cf d1 migrations apply` names a database.
 */
export function cfBuiltWorker(output: string): CfBuiltWorker {
  const unreadable = 'CloudChef couldn’t read the settings the build left for its Worker.';
  const lines = output.trim().split('\n');
  if (lines[0] === 'no-worker') {
    const looked = cfBuildOutput(`{${CF_BUILD_OUTPUT_VERSIONS.join(',')}}`).workerConfig;
    return {
      stage: 'build',
      reason: `The build didn’t leave a Worker (${looked}). Its build script must run cf build.`,
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
  let built: BuiltWorkerConfig | undefined;
  try {
    const parsed = builtWorkerSchema.safeParse(JSON.parse(lines.slice(0, -1).join('\n')));
    built = parsed.success ? parsed.data : undefined;
  } catch {
    built = undefined;
  }
  if (!version || !built) {
    return { stage: 'config', reason: unreadable };
  }
  const { domains, triggers, ...settings } = built;
  const workerName = settings.name;
  if (!workerName || !WORKER_NAME.test(workerName)) {
    return {
      stage: 'config',
      reason: 'cloudflare.config.ts needs a name for the Worker: lowercase letters, digits and dashes.',
    };
  }
  const config: BuiltWorkerConfig = { ...settings, name: workerName };
  // A fetch trigger is a route: an address, like a domain.
  const kept = (triggers ?? []).filter((trigger) => trigger.type !== 'fetch');
  if (kept.length > 0) {
    config.triggers = kept;
  }
  const notes: string[] = [];
  if ((domains ?? []).length > 0 || kept.length !== (triggers ?? []).length) {
    notes.push(
      'The domains and routes in cloudflare.config.ts are not changed by publishing: the ones attached to the ' +
        'Worker stay as they are. Attach or remove one with cf.',
    );
  }
  const databases = Object.entries(settings.env ?? {}).filter(([, binding]) => binding.type === 'd1');
  let migrations: CfMigration[] = [];
  if (facts.includes('migrations=yes')) {
    const [only] = databases;
    if (databases.length === 1 && only && only[1].id !== undefined && D1_ID.test(only[1].id)) {
      migrations = [{ binding: only[0], databaseName: only[1].name ?? only[1].id, databaseId: only[1].id }];
    } else {
      notes.push(
        'The migrations folder was not applied: publishing applies it only when the project has exactly one D1 ' +
          'database, with its id in cloudflare.config.ts.',
      );
    }
  }
  return { config, workerName, version, migrations, notes };
}

/**
 * A built Worker's settings under the name CloudChef publishes it as, which is the project's Worker whatever its
 * config calls it (`cf` has no flag for the name). A binding to the Worker's own Durable Objects, Workflows or
 * entrypoints names it too, and follows it; one to another Worker is left as it is. Undefined when the settings
 * can't be read.
 */
export function namedWorkerConfig(text: string, workerName: string): BuiltWorkerConfig | undefined {
  let built: BuiltWorkerConfig;
  try {
    const parsed = builtWorkerSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      return undefined;
    }
    built = parsed.data;
  } catch {
    return undefined;
  }
  const { domains: _domains, ...settings } = built;
  const before = settings.name;
  const config: BuiltWorkerConfig = { ...settings, name: workerName };
  if (settings.env && before !== undefined && before !== workerName) {
    config.env = Object.fromEntries(
      Object.entries(settings.env).map(([name, binding]) => [
        name,
        binding.worker === before ? { ...binding, worker: workerName } : binding,
      ]),
    );
  }
  return config;
}

/** `cf`'s arguments for a D1 database's migrations, by its id, from the project's folder of them. */
export function cfMigrationsArgs(databaseId: string, directory = `${WORK_DIR}/migrations`): string {
  if (!D1_ID.test(databaseId)) {
    throw new Error('A D1 database’s migrations apply by its id.');
  }
  return `d1 migrations apply ${databaseId} --dir ${shellQuote(directory)}`;
}

/** `cf`'s arguments for publishing the sealed Worker: live for main, a version with an alias for another branch. */
export function cfPublishArgs(kind: 'production' | 'preview', alias: string): string {
  return kind === 'production'
    ? 'deploy --prebuilt --provision=false'
    : `workers versions create --prebuilt --preview-alias ${shellQuote(alias)}`;
}

const subdomainSchema = z.object({ result: z.object({ subdomain: z.string().regex(/^[a-z0-9-]+$/) }) });
const workerSubdomainSchema = z.object({ result: z.object({ enabled: z.boolean() }) });
const domainsSchema = z.object({ result: z.array(z.looseObject({ hostname: z.string().min(1) })) });
const versionSchema = z.looseObject({
  metadata: z.looseObject({ has_preview: z.boolean().optional() }).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});
/** Newest first, as Cloudflare lists them. */
const versionsSchema = z.object({
  result: z.union([z.array(versionSchema), z.object({ items: z.array(versionSchema) })]),
});

/** The paths below the account, read with the deploy's token, that say where a publish is served. */
export function publishedAddressReads(
  kind: 'production' | 'preview',
  workerName: string,
): { subdomain: string; workerSubdomain?: string; domains?: string; versions?: string } {
  const subdomain = '/workers/subdomain';
  return kind === 'production'
    ? {
        subdomain,
        workerSubdomain: `/workers/scripts/${workerName}/subdomain`,
        domains: `/workers/domains?service=${workerName}`,
      }
    : { subdomain, versions: `/workers/scripts/${workerName}/versions?per_page=10` };
}

/**
 * Where a publish is served, from what Cloudflare's API says once `cf` is done (`cf` writes no record of it, as
 * Wrangler did): for main, the Worker's workers.dev address when it has one, else its first custom domain; for a
 * branch, the alias of the newest version uploaded with it, when that version has a preview (one of a Worker with
 * Durable Objects has none). Null when it has no address or the answers can't be read.
 */
export function publishedAddress(args: {
  kind: 'production' | 'preview';
  workerName: string;
  alias: string;
  answers: { subdomain?: unknown; workerSubdomain?: unknown; domains?: unknown; versions?: unknown };
}): string | null {
  const subdomain = subdomainSchema.safeParse(args.answers.subdomain);
  const workersDev = subdomain.success ? `${subdomain.data.result.subdomain}.workers.dev` : null;
  if (args.kind === 'preview') {
    const versions = versionsSchema.safeParse(args.answers.versions);
    const listed = versions.success ? versions.data.result : [];
    const uploaded = (Array.isArray(listed) ? listed : listed.items).find(
      (version) => version.annotations?.['workers/alias'] === args.alias,
    );
    return workersDev && uploaded?.metadata?.has_preview === true
      ? `https://${args.alias}-${args.workerName}.${workersDev}`
      : null;
  }
  const enabled = workerSubdomainSchema.safeParse(args.answers.workerSubdomain);
  if (workersDev && enabled.success && enabled.data.result.enabled) {
    return `https://${args.workerName}.${workersDev}`;
  }
  const domains = domainsSchema.safeParse(args.answers.domains);
  const hostname = domains.success ? domains.data.result[0]?.hostname : undefined;
  return hostname && /^[a-z0-9.-]+$/i.test(hostname) ? `https://${hostname}` : null;
}
