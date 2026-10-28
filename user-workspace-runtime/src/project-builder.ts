import { WorkerEntrypoint } from 'cloudflare:workers';
import { Sandbox, type SandboxCommand } from '@cloudflare/sandbox';
import { createExtensionProcessSandbox } from '@cloudflare/sandbox/extensions';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { runtimeConnectionIdentity } from '../../app/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import {
  deployApiDecision,
  deployBindingsCheck,
  isCloudChefResourceName,
  workerSettingsSchema,
  type BindingLookups,
} from '../../app/lib/.server/cloudflare/deploy-api-policy';
import { GIT_PROXY_HOST, handleGitProxyRequest, workspaceRefsPrefix } from '../../app/lib/.server/cloudflare/git-proxy';
import {
  claimProjectDeployment,
  projectDeploymentCredential,
  reportProjectDeployment,
  retryProjectDeployment,
  type DeploymentReportOutcome,
} from '../../app/lib/.server/cloudflare/linked-project-client';
import {
  BUILD_PLAN_FILES,
  buildPlan,
  deployWorkerName,
  isCloudChefWorkerName,
  withoutJsonComments,
  type BuildPlan,
} from '../../app/lib/.server/cloudflare/project-build-plan';
import { ProjectRepositories } from '../../app/lib/.server/cloudflare/project-repository';
import {
  readRuntimeUpgradeWindow,
  recordRuntimeActivity,
} from '../../app/lib/.server/cloudflare/user-workspace-runtime-activity';
import {
  asBuildUserCommand,
  BUILD_USER,
  BUILD_UID,
  endBuildPhase,
  fetchCommand,
  WORK_DIR,
} from './project-builder-scripts';
import { runTrackedSandboxCommand } from './tracked-command';
import { shellQuote } from './shell-quote';
import { first } from './sql-rows';
import { CONTAINER_TOOL_ENV } from './computer-sandbox';

/**
 * Builds and deploys a project CloudChef deploys itself (one uploaded as a ZIP), one commit at a time, in a container
 * of its own: one ProjectBuilder per project, in the runtime of the person whose push or upload it is. It runs the
 * same steps every time, with no agent:
 *
 *   1. read how the commit builds from its own files (`buildPlan`), in the Worker;
 *   2. fetch that commit through a read-only git proxy, install its packages and build it, as an unprivileged user
 *      that holds no credential;
 *   3. stop every process of that user, take the files from it, and write the Wrangler config the deploy uses
 *      without any build command, so nothing of the project runs from then on;
 *   4. apply its D1 migrations and deploy with CloudChef's own Wrangler, whose every request to Cloudflare this
 *      builder sends on itself, with the account's authorization, only while the control plane says this deploy is
 *      running and only if it is one a deploy of this one Worker may make (`deployApiDecision`): the token never
 *      leaves this object;
 *   5. report how it went, keeping the log here, in the person's own account.
 *
 * Each step runs in a scheduled call of its own, so none outlasts the time one may run; between them the job's
 * step is kept here, and a job whose container was lost starts over, a few times at most. While a step runs, a
 * heartbeat renews the deploy's lease and stops the work as soon as a newer commit supersedes it; and the runtime
 * counts as busy, so an upgrade never cuts a deploy off.
 */

/** CloudChef's own Wrangler, which deploys; the project's own copy only ever builds. */
const WRANGLER_VERSION = '4.151.3';
const WRANGLER_ROOT = '/opt/cloudchef/wrangler';
const WRANGLER = `${WRANGLER_ROOT}/node_modules/.bin/wrangler`;
/** The deploy's own address for Cloudflare's API, which the deploy proxy answers. */
const DEPLOY_API_HOST = 'cloudflare-api.internal';
const CLOUDFLARE_API = 'https://api.cloudflare.com';
const WRANGLER_OUTPUT = '/tmp/wrangler-output.ndjson';
const WRANGLER_LOG_DIR = '/tmp/wrangler-logs';
/** The config the deploy uses, written next to the one it comes from. */
const DEPLOY_CONFIG_NAME = 'cloudchef.deploy.json';

/** Each under the time one scheduled call may run, with room for the step around it. */
const INSTALL_TIMEOUT_MS = 12 * 60_000;
const BUILD_TIMEOUT_MS = 12 * 60_000;
const DEPLOY_TIMEOUT_MS = 10 * 60_000;
const SHORT_TIMEOUT_MS = 2 * 60_000;
const HEARTBEAT_MS = 45_000;
/** How long a deploy waits for another of the project to finish, in rounds of `BUSY_WAIT_SECONDS`. */
const BUSY_WAIT_SECONDS = 20;
const MAX_BUSY_WAITS = 40;
/** How often a job whose container was lost starts over before it counts as failed. */
const MAX_RESTARTS = 2;
const UPGRADE_WAIT_SECONDS = 60;
/**
 * A step that starts this soon into a scheduled call runs in the same call; the longest step's timeout and this
 * stay within the time one call may run.
 */
const SAME_CALL_MS = 60_000;
/** The account's token is asked for again this often while a deploy runs, so a stopped one loses it soon. */
const TOKEN_REUSE_MS = 20_000;
const MAX_LOG_CHARACTERS = 64 * 1024;
const KEPT_LOGS = 10;

type BuilderEnv = {
  PROJECT_BUILDER: DurableObjectNamespace<ProjectBuilder>;
  ARTIFACTS: Artifacts;
  DB: D1Database;
  CONTROL_PLANE_SECRET: string;
  CLOUDCHEF_CONTROL_PLANE_ENDPOINT: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDCHEF_USER_ID: string;
  CLOUDCHEF_CONNECTION_ID: string;
  CLOUDCHEF_CONNECTION_GENERATION: string;
  CLOUDCHEF_USER_RUNTIME: string;
};

type Step = 'prepare' | 'install' | 'build' | 'config-build' | 'seal' | 'migrate' | 'deploy';
type DeployablePlan = Extract<BuildPlan, { deployable: true }>;
type WorkerSettings = z.infer<typeof workerSettingsSchema>;
type ReportFields = Omit<Parameters<typeof reportProjectDeployment>[2], 'orgProjectId' | 'deploymentId'>;

type Job = {
  deploymentId: string;
  orgProjectId: string;
  repo: string;
  branch: string;
  commit: string;
  kind: 'production' | 'preview';
  recordedWorker: string | null;
  step: Step;
  restarts: number;
  waits: number;
  plan: DeployablePlan | null;
  workerName: string | null;
  nameTaken: boolean;
  deployConfig: string | null;
  /** How many of the plan's D1 databases have had their migrations applied. */
  migrated: number;
};

type JobRow = {
  deployment_id: string;
  org_project_id: string;
  repo: string;
  branch: string;
  commit_sha: string;
  kind: 'production' | 'preview';
  recorded_worker: string | null;
  status: 'pending' | 'running' | 'done';
  step: Step;
  restarts: number;
  waits: number;
  plan: string | null;
  worker_name: string | null;
  name_taken: number;
  deploy_config: string | null;
  migrated: number;
};

const jobSchema = z.object({
  orgProjectId: z.string().uuid(),
  branch: z.string().regex(/^[A-Za-z0-9._/-]{1,255}$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  headReadAt: z.number().int().positive().optional(),
});

const planSchema = z.looseObject({
  deployable: z.literal(true),
  packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']),
  install: z.string(),
  build: z.string().nullable(),
  configBuild: z.string().nullable(),
  configFile: z.enum(['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']),
  workerName: z.string(),
  migrations: z.array(z.object({ binding: z.string(), databaseName: z.string() })),
});

/** What a step leads to: the next step, a wait before this one is tried again, or the end of the job. */
type StepOutcome = { next: Step } | { waitSeconds: number } | 'done';

/** A step that failed, with where it failed and what to tell the person. */
class StepFailure extends Error {
  constructor(
    readonly stage: 'config' | 'install' | 'build' | 'migrations' | 'deploy' | 'interrupted',
    message: string,
  ) {
    super(message);
    this.name = 'StepFailure';
  }
}

/** The work was superseded by a newer commit, or isn't this runtime's any more: stop quietly. */
class StepAbandoned extends Error {}

const DEPLOY_REFUSED = (message: string) =>
  Response.json({ success: false, errors: [{ code: 10000, message }] }, { status: 403 });

export class ProjectBuilder extends Sandbox<BuilderEnv> {
  // Kept a while after a publish, so the project's next one finds its tools and package downloads in place.
  override sleepAfter = '15m';
  private readonly processes = createExtensionProcessSandbox(this);
  #deployToken: { deploymentId: string; token: string; at: number } | null = null;
  /** When the last step ended, so one scheduled call runs only one step even if several calls fall due at once. */
  #lastStepEndedAt = 0;
  /** The deploy proxy's requests in the running Wrangler command, summed up in the log when it ends. */
  #requests: RequestTally = emptyRequestTally();
  /** When the scheduled call the next step runs in started, if a step just ended in it. */
  #callStartedAt: number | null = null;

  constructor(ctx: DurableObjectState<{}>, env: BuilderEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS builder_jobs (
      deployment_id TEXT PRIMARY KEY,
      org_project_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      branch TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      kind TEXT NOT NULL,
      recorded_worker TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done')),
      step TEXT NOT NULL DEFAULT 'prepare',
      restarts INTEGER NOT NULL DEFAULT 0,
      waits INTEGER NOT NULL DEFAULT 0,
      plan TEXT,
      worker_name TEXT,
      name_taken INTEGER NOT NULL DEFAULT 0,
      deploy_config TEXT,
      migrated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS builder_logs (
      deployment_id TEXT PRIMARY KEY,
      log TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    // Which deploy, of which Worker, may send requests to Cloudflare now: none, outside a deploy step.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS builder_gate (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      deployment_id TEXT NOT NULL,
      org_project_id TEXT NOT NULL,
      worker_name TEXT NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS builder_proxy_key (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      key TEXT NOT NULL
    )`);
    // A fresh instance runs no step yet, so a gate the last one left open is closed.
    ctx.storage.sql.exec('DELETE FROM builder_gate');
  }

  /**
   * Builds and deploys `commit` of `branch` once the control plane hands it to this runtime: the first time it is
   * asked for that commit, or when the runtime that had it stopped. A later ask for a commit claimed does nothing.
   */
  async enqueue(value: {
    orgProjectId: string;
    branch: string;
    commit: string;
    headReadAt?: number;
  }): Promise<{ queued: boolean }> {
    const request = jobSchema.parse(value);
    const claimed = await claimProjectDeployment(this.env, this.identity(), request);
    if (!claimed.claimed) {
      return { queued: false };
    }
    await this.addJob({
      deploymentId: claimed.deploymentId,
      orgProjectId: request.orgProjectId,
      repo: claimed.repo,
      branch: request.branch,
      commit: request.commit,
      kind: claimed.kind,
      recordedWorker: claimed.workerName,
    });
    return { queued: true };
  }

  /** Starts a failed deploy again, or one that went to a derived name again to its config's Worker, as a new attempt. */
  async retry(value: {
    orgProjectId: string;
    deploymentId: string;
    toWantedWorker?: true;
  }): Promise<{ deploymentId: string }> {
    const identity = this.identity();
    const retried = await retryProjectDeployment(this.env, identity, value);
    const claimed = await claimProjectDeployment(this.env, identity, {
      orgProjectId: value.orgProjectId,
      branch: retried.branch,
      commit: retried.commit,
    });
    await this.addJob({
      deploymentId: retried.deploymentId,
      orgProjectId: value.orgProjectId,
      repo: claimed.repo,
      branch: retried.branch,
      commit: retried.commit,
      kind: retried.kind,
      recordedWorker: claimed.workerName,
    });
    return { deploymentId: retried.deploymentId };
  }

  /** The end of a deploy's log, as this runtime kept it; none for one another runtime ran. */
  log(deploymentId: string): string | null {
    return (
      first(
        this.ctx.storage.sql.exec<{ log: string }>(
          'SELECT log FROM builder_logs WHERE deployment_id = ?',
          deploymentId,
        ),
      )?.log ?? null
    );
  }

  /** A job from its first step, replacing any earlier run of the same deployment. */
  private async addJob(
    job: Pick<Job, 'deploymentId' | 'orgProjectId' | 'repo' | 'branch' | 'commit' | 'kind' | 'recordedWorker'>,
  ): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO builder_jobs (deployment_id, org_project_id, repo, branch, commit_sha, kind, recorded_worker, status,
         created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(deployment_id) DO UPDATE SET repo = excluded.repo, recorded_worker = excluded.recorded_worker,
         status = 'pending', step = 'prepare', restarts = 0, waits = 0, plan = NULL, worker_name = NULL,
         name_taken = 0, deploy_config = NULL, migrated = 0, created_at = excluded.created_at`,
      job.deploymentId,
      job.orgProjectId,
      job.repo,
      job.branch,
      job.commit,
      job.kind,
      job.recordedWorker,
      Date.now(),
    );
    await this.schedule(0, 'runNext', {});
  }

  /** Runs one step of the oldest unfinished job, then the next: in the same call while it is young, else scheduled. */
  async runNext(): Promise<void> {
    const chained = this.#callStartedAt;
    const callStartedAt = chained ?? Date.now();
    this.#callStartedAt = null;
    this.closeGate();
    if (chained === null && Date.now() - this.#lastStepEndedAt < 900) {
      // Another call already ran a step in this scheduled run; the next goes in a run of its own.
      await this.schedule(1, 'runNext', {});
      return;
    }
    const row = first(
      this.ctx.storage.sql.exec<JobRow>(
        `SELECT * FROM builder_jobs WHERE status IN ('pending', 'running') ORDER BY created_at LIMIT 1`,
      ),
    );
    if (!row) {
      await this.markBusy(false);
      return;
    }
    if (!(await this.mayStart())) {
      // The container is kept from going idle meanwhile, so the job carries on where it was.
      if (row.status === 'pending' && row.step !== 'prepare') {
        await this.containerHasJob(toJob(row));
      }
      await this.schedule(UPGRADE_WAIT_SECONDS, 'runNext', {});
      return;
    }
    const job = toJob(row);
    if (row.status === 'running') {
      // The last step stopped partway (its container or this object went away): the job starts over.
      job.restarts += 1;
      job.step = 'prepare';
    }
    this.ctx.storage.sql.exec(
      "UPDATE builder_jobs SET status = 'running', step = ?, restarts = ? WHERE deployment_id = ?",
      job.step,
      job.restarts,
      job.deploymentId,
    );
    let outcome: StepOutcome;
    try {
      if (job.restarts > MAX_RESTARTS) {
        throw new StepFailure('interrupted', 'Publishing kept stopping partway.');
      }
      const started = Date.now();
      outcome = await this.runStep(job);
      this.appendLog(job, `[${job.step}: ${seconds(Date.now() - started)}]\n`);
    } catch (error) {
      await this.endJob(
        job,
        error instanceof StepAbandoned || error instanceof StepFailure
          ? error
          : new StepFailure('interrupted', 'Publishing stopped partway.'),
      );
      outcome = 'done';
    } finally {
      this.closeGate();
      this.#lastStepEndedAt = Date.now();
    }
    if (outcome === 'done') {
      this.ctx.storage.sql.exec("UPDATE builder_jobs SET status = 'done' WHERE deployment_id = ?", job.deploymentId);
      this.ctx.storage.sql.exec(
        `DELETE FROM builder_logs WHERE deployment_id NOT IN (
           SELECT deployment_id FROM builder_logs ORDER BY updated_at DESC LIMIT ?)`,
        KEPT_LOGS,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM builder_jobs WHERE status = 'done' AND deployment_id != ?",
        job.deploymentId,
      );
      await this.schedule(1, 'runNext', {});
      return;
    }
    if ('waitSeconds' in outcome) {
      this.ctx.storage.sql.exec(
        "UPDATE builder_jobs SET status = 'pending', waits = waits + 1 WHERE deployment_id = ?",
        job.deploymentId,
      );
      await this.schedule(outcome.waitSeconds, 'runNext', {});
      return;
    }
    this.ctx.storage.sql.exec(
      "UPDATE builder_jobs SET status = 'pending', step = ? WHERE deployment_id = ?",
      outcome.next,
      job.deploymentId,
    );
    if (Date.now() - callStartedAt < SAME_CALL_MS) {
      this.#callStartedAt = callStartedAt;
      await this.runNext();
      return;
    }
    await this.schedule(1, 'runNext', {});
  }

  private async runStep(job: Job): Promise<StepOutcome> {
    if (job.step === 'prepare') {
      return this.prepare(job);
    }
    const plan = job.plan;
    if (!plan || !(await this.containerHasJob(job))) {
      // The container went away between steps: start over from a fresh one.
      this.ctx.storage.sql.exec(
        'UPDATE builder_jobs SET restarts = restarts + 1 WHERE deployment_id = ?',
        job.deploymentId,
      );
      return { next: 'prepare' };
    }
    switch (job.step) {
      case 'install':
        await this.expectRecorded(this.report(job, { state: 'building', step: 'installing' }));
        await this.whileReporting(job, 'building', () =>
          this.asBuildUser(job, 'install', plan.install, INSTALL_TIMEOUT_MS),
        );
        return { next: 'build' };
      case 'build':
      case 'config-build': {
        const command = job.step === 'build' ? plan.build : plan.configBuild;
        if (command) {
          await this.expectRecorded(this.report(job, { state: 'building', step: 'building' }));
          await this.whileReporting(job, 'building', () => this.asBuildUser(job, 'build', command, BUILD_TIMEOUT_MS));
        }
        return { next: job.step === 'build' ? 'config-build' : 'seal' };
      }
      case 'seal':
        await this.whileReporting(job, 'building', () => this.seal(job, plan));
        return { next: 'migrate' };
      case 'migrate':
        return this.migrate(job, plan);
      case 'deploy':
        return this.deployStep(job, plan);
    }
  }

  /** How the commit builds, read in the Worker; then a fresh container with the commit fetched into it. */
  private async prepare(job: Job): Promise<StepOutcome> {
    const plan = await this.plan(job);
    if (!plan.deployable) {
      await this.report(job, { state: 'not_deployable', reason: plan.reason });
      return 'done';
    }
    await this.expectRecorded(this.report(job, { state: 'building', step: 'preparing' }));
    this.ctx.storage.sql.exec(
      `UPDATE builder_jobs SET plan = ?, worker_name = NULL, name_taken = 0, deploy_config = NULL, migrated = 0
       WHERE deployment_id = ?`,
      JSON.stringify(plan),
      job.deploymentId,
    );
    await this.whileReporting(job, 'building', async () => {
      const started = Date.now();
      await this.prepareContainer();
      this.appendLog(job, `[build machine set up: ${seconds(Date.now() - started)}]\n`);
      await this.asBuildUser(job, 'install', fetchCommand(job), SHORT_TIMEOUT_MS);
      await this.command(`touch ${jobMarker(job)}`, SHORT_TIMEOUT_MS);
    });
    return { next: 'install' };
  }

  /**
   * Ends the build: every process of the build user is stopped, the files are taken from it, the history and local
   * secrets are removed, and the Wrangler config the deploy uses is written from the one the build left (its own,
   * or the one a build tool such as the Cloudflare Vite plugin points to), without any build command.
   */
  private async seal(job: Job, plan: DeployablePlan): Promise<void> {
    await this.root(job, 'build', endBuildPhase(), SHORT_TIMEOUT_MS);
    const source = await this.effectiveConfigPath(plan);
    const text = (await this.command(`cat ${shellQuote(source)}`, SHORT_TIMEOUT_MS)).stdout;
    const config = readWranglerConfig(source, text);
    if (!config) {
      throw new StepFailure('config', `CloudChef couldn’t read the Wrangler config the build left (${source}).`);
    }
    delete config.build;
    await this.confinePaths(source, config);
    const target = `${source.slice(0, source.lastIndexOf('/'))}/${DEPLOY_CONFIG_NAME}`;
    const encoded = base64(new TextEncoder().encode(JSON.stringify(config)));
    await this.command(
      `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(target)} && rm -rf ${WORK_DIR}/.wrangler/deploy`,
      SHORT_TIMEOUT_MS,
    );
    this.ctx.storage.sql.exec(
      'UPDATE builder_jobs SET deploy_config = ? WHERE deployment_id = ?',
      target,
      job.deploymentId,
    );
  }

  /** Refuses a config whose code, assets or migrations are read from outside the project. */
  private async confinePaths(source: string, config: z.infer<typeof wranglerConfigSchema>): Promise<void> {
    const directory = source.slice(0, source.lastIndexOf('/'));
    const paths = [
      config.main,
      config.base_dir,
      config.assets?.directory,
      ...(config.d1_databases ?? []).map((database) => database.migrations_dir),
    ].flatMap((path) => (path ? [path] : []));
    if (paths.length === 0) {
      return;
    }
    const resolved = (
      await this.command(
        `cd ${shellQuote(directory)} && realpath -m -- ${paths.map((path) => shellQuote(path)).join(' ')}`,
        SHORT_TIMEOUT_MS,
      )
    ).stdout
      .trim()
      .split('\n');
    if (resolved.length !== paths.length || resolved.some((path) => !path.startsWith(`${WORK_DIR}/`))) {
      throw new StepFailure('config', 'The Wrangler config the build left reads files from outside the project.');
    }
  }

  /** The config the build left: the redirect a build tool writes, kept inside the project, or the project's own. */
  private async effectiveConfigPath(plan: DeployablePlan): Promise<string> {
    const redirect = (
      await this.command(`cat ${WORK_DIR}/.wrangler/deploy/config.json 2>/dev/null || true`, SHORT_TIMEOUT_MS)
    ).stdout.trim();
    let wanted = `${WORK_DIR}/${plan.configFile}`;
    if (redirect) {
      const configPath = parseJson(redirect, z.object({ configPath: z.string().min(1) }))?.configPath;
      if (!configPath) {
        throw new StepFailure('config', 'The build left a Wrangler config redirect CloudChef couldn’t read.');
      }
      wanted = configPath.startsWith('/') ? configPath : `${WORK_DIR}/.wrangler/deploy/${configPath}`;
    }
    const resolved = (await this.command(`realpath -e ${shellQuote(wanted)}`, SHORT_TIMEOUT_MS)).stdout.trim();
    if (!resolved.startsWith(`${WORK_DIR}/`) || !/\.(json|jsonc|toml)$/.test(resolved)) {
      throw new StepFailure('config', 'The build pointed to a Wrangler config outside the project.');
    }
    return resolved;
  }

  /**
   * Moves the deployment to deploying (waiting while another deploy of the project runs) and holds its Worker; then,
   * one database per call, applies the config's D1 migrations, before the new code goes live.
   */
  private async migrate(job: Job, plan: DeployablePlan): Promise<StepOutcome> {
    const deployConfig = job.deployConfig;
    if (!deployConfig) {
      throw new StepFailure('interrupted', 'Publishing lost its place.');
    }
    if (!job.workerName) {
      const started = await this.reportWithWorker(job, { state: 'deploying' });
      if (started.outcome === 'busy') {
        if (job.waits >= MAX_BUSY_WAITS) {
          throw new StepFailure('deploy', 'Another publish of this project took too long to finish.');
        }
        // Its lease is renewed while it waits, as building.
        await this.expectRecorded(this.report(job, { state: 'building' }));
        return { waitSeconds: BUSY_WAIT_SECONDS };
      }
      await this.expectRecorded(Promise.resolve(started.outcome));
      const worker = await this.chooseWorker(job, plan, started.workerName ?? job.recordedWorker);
      const held = await this.reportWithWorker(job, { state: 'deploying', workerName: worker.name });
      if (held.outcome === 'worker_taken') {
        this.appendLog(job, `\nAnother project publishes to the Worker named ${worker.name}.\n`);
        return 'done';
      }
      await this.expectRecorded(Promise.resolve(held.outcome));
      this.ctx.storage.sql.exec(
        'UPDATE builder_jobs SET worker_name = ?, name_taken = ? WHERE deployment_id = ?',
        worker.name,
        worker.nameTaken ? 1 : 0,
        job.deploymentId,
      );
      return { next: 'migrate' };
    }
    const database = job.kind === 'production' ? plan.migrations[job.migrated] : undefined;
    if (!database) {
      return { next: 'deploy' };
    }
    await this.expectRecorded(this.report(job, { state: 'deploying', workerName: job.workerName, step: 'migrating' }));
    this.openGate(job, job.workerName);
    await this.whileReporting(job, 'deploying', async () => {
      this.appendLog(job, `\n$ wrangler d1 migrations apply ${database.databaseName} --remote\n`);
      await this.runWrangler(
        job,
        'migrations',
        `d1 migrations apply ${shellQuote(database.databaseName)} --remote --config ${shellQuote(deployConfig)}`,
      );
    });
    this.ctx.storage.sql.exec(
      'UPDATE builder_jobs SET migrated = migrated + 1 WHERE deployment_id = ?',
      job.deploymentId,
    );
    return { next: 'migrate' };
  }

  /** Deploys (main) or uploads a preview (another branch), then reports where it went. */
  private async deployStep(job: Job, plan: DeployablePlan): Promise<StepOutcome> {
    const workerName = job.workerName;
    if (!workerName || !job.deployConfig) {
      throw new StepFailure('interrupted', 'Publishing lost its place.');
    }
    await this.expectRecorded(this.report(job, { state: 'deploying', workerName, step: 'publishing' }));
    this.openGate(job, workerName);
    const config = ` --config ${shellQuote(job.deployConfig)}`;
    const command =
      job.kind === 'production'
        ? `deploy --name ${workerName}${config}`
        : `versions upload --name ${workerName} --preview-alias ${previewAlias(job.branch)}${config}`;
    const url = await this.whileReporting(job, 'deploying', async () => {
      this.appendLog(job, `\n$ wrangler ${command}\n`);
      await this.runWrangler(job, 'deploy', command);
      const output = await this.command(`cat ${WRANGLER_OUTPUT} 2>/dev/null || true`, SHORT_TIMEOUT_MS);
      return deployedUrl(output.stdout, job.kind);
    });
    const succeeded: Parameters<typeof reportProjectDeployment>[2] = {
      orgProjectId: job.orgProjectId,
      deploymentId: job.deploymentId,
      state: 'succeeded',
      workerName,
    };
    if (url) {
      succeeded.url = url;
    }
    if (job.nameTaken && isCloudChefWorkerName(plan.workerName)) {
      succeeded.reason = `${plan.workerName} is a name CloudChef uses itself, so this went to ${workerName}.`;
    } else if (job.nameTaken) {
      succeeded.reason = `A Worker named ${plan.workerName} was already in the account, so this went to ${workerName}.`;
      succeeded.wantedWorkerName = plan.workerName;
    }
    await reportProjectDeployment(this.env, this.identity(), succeeded);
    return 'done';
  }

  /** Records how a job ended that didn't succeed: quietly when it was superseded, else with its stage and reason. */
  private async endJob(job: Job, error: StepAbandoned | StepFailure): Promise<void> {
    if (error instanceof StepAbandoned) {
      // A superseded deploy that stopped lets the newer one go ahead at once.
      await this.report(job, { state: 'failed', failureStage: 'interrupted' }).catch(() => undefined);
      return;
    }
    this.appendLog(job, `\n${error.message}\n`);
    await this.report(job, { state: 'failed', failureStage: error.stage, reason: error.message }).catch(
      () => undefined,
    );
  }

  private async report(job: Job, fields: ReportFields): Promise<DeploymentReportOutcome> {
    return (await this.reportWithWorker(job, fields)).outcome;
  }

  /** A report, and the Worker the project deploys as now. */
  private reportWithWorker(job: Job, fields: ReportFields) {
    return reportProjectDeployment(this.env, this.identity(), {
      orgProjectId: job.orgProjectId,
      deploymentId: job.deploymentId,
      ...fields,
    });
  }

  /** A report that says to stop (superseded, or not this runtime's) ends the job quietly. */
  private async expectRecorded(outcome: Promise<DeploymentReportOutcome>): Promise<void> {
    if ((await outcome) !== 'recorded') {
      throw new StepAbandoned();
    }
  }

  /**
   * Runs `work` while renewing the deploy's lease and the runtime's busy mark; a heartbeat that finds the deploy
   * superseded (or no longer this runtime's) stops the container, so the work ends at once, abandoned.
   */
  private async whileReporting<T>(job: Job, state: 'building' | 'deploying', work: () => Promise<T>): Promise<T> {
    let stopped = false;
    const timer = setInterval(() => {
      void this.markBusy(true).catch(() => undefined);
      void this.report(job, { state })
        .then((outcome) => {
          if (outcome === 'superseded' || outcome === 'refused') {
            stopped = true;
            this.closeGate();
            void this.destroy().catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }, HEARTBEAT_MS);
    try {
      const result = await work();
      if (stopped) {
        throw new StepAbandoned();
      }
      return result;
    } catch (error) {
      throw stopped ? new StepAbandoned() : error;
    } finally {
      clearInterval(timer);
    }
  }

  /** Whether a step may start: never while an upgrade holds the runtime's window; the runtime is busy from then on. */
  private async mayStart(): Promise<boolean> {
    if (await readRuntimeUpgradeWindow(this.env.DB, Date.now())) {
      return false;
    }
    await this.markBusy(true);
    // An upgrade that claimed the window just before this was marked busy goes first.
    if (await readRuntimeUpgradeWindow(this.env.DB, Date.now())) {
      await this.markBusy(false);
      return false;
    }
    return true;
  }

  private markBusy(busy: boolean): Promise<void> {
    return recordRuntimeActivity(this.env.DB, {
      agentName: `project-builder:${this.ctx.id.toString()}`,
      busy,
      now: Date.now(),
    });
  }

  /** How the commit builds, from its own files, read in the Worker before anything runs. */
  private async plan(job: Job): Promise<BuildPlan> {
    const repositories = new ProjectRepositories(this.env.ARTIFACTS);
    const { files } = await repositories.readTreeAt(job.repo, job.commit);
    const contents: Partial<Record<(typeof BUILD_PLAN_FILES)[number], string>> = {};
    for (const file of files) {
      const name = BUILD_PLAN_FILES.find((planFile) => planFile === file.path);
      if (name) {
        // Lockfiles only need to be there; the rest are read.
        contents[name] = /lock|yarnrc/.test(name)
          ? ''
          : new TextDecoder().decode(await repositories.readBlob(job.repo, file.oid));
      }
    }
    return buildPlan(contents);
  }

  /**
   * The container with the build user, CloudChef's Wrangler, and the two proxies it reaches the world through: the
   * one the project's last publish left, if it is still running, else a fresh one. Only what tools and package
   * managers downloaded carries over; nothing of the last publish's own is left running or in the work folder.
   * Anyone who can publish a branch of the project can publish its main too, so this lets no one do anything new.
   */
  private async prepareContainer(): Promise<void> {
    if (!this.ctx.container?.running) {
      await this.destroy().catch(() => undefined);
      await this.start();
    }
    const exports = builderExports(this.ctx.exports);
    // Only the proxies made for this container hold the key; anything else that reaches this builder (a Worker
    // binding it, say) can neither read the source nor send through the deploy proxy.
    const proxyKey = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO builder_proxy_key (singleton, key) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET key = excluded.key`,
      proxyKey,
    );
    const props = { props: { builderId: this.ctx.id.toString(), proxyKey } };
    await this.ctx.container!.interceptOutboundHttp(GIT_PROXY_HOST, exports.BuilderSourceProxy(props));
    await this.ctx.container!.interceptOutboundHttp(DEPLOY_API_HOST, exports.DeployApiProxy(props));
    await this.command(
      [
        'set -eu',
        `id -u ${BUILD_USER} >/dev/null 2>&1 || useradd --uid ${BUILD_UID} --create-home ${BUILD_USER}`,
        `pkill -KILL -u ${BUILD_USER} || true`,
        `rm -rf ${WORK_DIR} ${WRANGLER_OUTPUT} ${WRANGLER_LOG_DIR} /opt/cloudchef/job-*`,
        `mkdir -p ${WORK_DIR} && chown ${BUILD_USER}:${BUILD_USER} ${WORK_DIR}`,
        `[ -x ${WRANGLER} ] || npm install --prefix ${WRANGLER_ROOT} wrangler@${WRANGLER_VERSION} --ignore-scripts --no-audit --no-fund --loglevel=error`,
        'command -v pnpm >/dev/null 2>&1 || npm install --global pnpm --ignore-scripts --no-audit --no-fund --loglevel=error',
        'corepack enable >/dev/null 2>&1 || true',
      ].join('\n'),
      SHORT_TIMEOUT_MS * 2,
    );
  }

  /** Whether this container is the one the job's earlier steps ran in. */
  private async containerHasJob(job: Job): Promise<boolean> {
    try {
      await this.command(`test -f ${jobMarker(job)}`, SHORT_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  private async asBuildUser(job: Job, stage: 'install' | 'build', command: string, timeout: number): Promise<void> {
    const wrapped = asBuildUserCommand(command);
    this.appendLog(job, `\n$ ${command}\n`);
    await this.logged(job, stage, wrapped, timeout);
  }

  private async root(job: Job, stage: 'build', command: string, timeout: number): Promise<void> {
    await this.logged(job, stage, command, timeout);
  }

  private async logged(job: Job, stage: 'install' | 'build', command: string, timeout: number): Promise<void> {
    try {
      const output = await this.command(command, timeout);
      this.appendLog(job, `${output.stdout}${output.stderr}`);
    } catch (error) {
      this.appendLog(job, `${error instanceof Error ? error.message : String(error)}\n`);
      throw new StepFailure(stage, failureSentence(stage));
    }
  }

  private command(command: string, timeout: number, env?: Record<string, string>) {
    const argv: SandboxCommand = ['/bin/bash', '-lc', command];
    return runTrackedSandboxCommand({
      command: argv,
      timeout,
      exec: (commandArgv, options) =>
        this.processes.exec(commandArgv, { ...options, env: { ...CONTAINER_TOOL_ENV, ...env } }),
    });
  }

  /**
   * The Worker this deploy goes to: the one the project already deploys as, else its config's name if the account
   * has no Worker of that name, else a free one derived from it. Only Cloudflare's "not found" counts as free.
   */
  private async chooseWorker(
    job: Job,
    plan: DeployablePlan,
    held: string | null,
  ): Promise<{ name: string; nameTaken: boolean }> {
    if (held) {
      return { name: held, nameTaken: held !== plan.workerName };
    }
    const response = await this.cloudflare(job, `/workers/services/${plan.workerName}`);
    await response.body?.cancel().catch(() => undefined);
    if (response.status !== 200 && response.status !== 404) {
      throw new StepFailure('deploy', `CloudChef couldn’t check whether a Worker named ${plan.workerName} exists.`);
    }
    return deployWorkerName({
      recorded: null,
      configName: plan.workerName,
      projectId: job.orgProjectId,
      configNameTaken: response.status === 200,
    });
  }

  private async runWrangler(job: Job, stage: 'deploy' | 'migrations', args: string): Promise<void> {
    const env = {
      CLOUDFLARE_API_BASE_URL: `http://${DEPLOY_API_HOST}/client/v4`,
      // Wrangler needs a token to run unattended; this builder puts the real one in place of this.
      CLOUDFLARE_API_TOKEN: 'cloudchef-deploy-proxy',
      CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_OUTPUT_FILE_PATH: WRANGLER_OUTPUT,
      // Wrangler's own log, which has its debug lines too, read into the deploy's log when it fails without saying
      // why on screen.
      WRANGLER_LOG_PATH: WRANGLER_LOG_DIR,
      // The project's history is gone; no git Wrangler runs finds any other.
      GIT_DIR: '/nonexistent',
      GIT_CEILING_DIRECTORIES: '/',
      CI: '1',
    };
    this.#requests = emptyRequestTally();
    try {
      const output = await this.command(`cd ${WORK_DIR} && ${WRANGLER} ${args}`, DEPLOY_TIMEOUT_MS, env);
      this.appendLog(job, `${output.stdout}${output.stderr}`);
      this.appendLog(job, requestTallyLine(this.#requests));
    } catch (error) {
      this.appendLog(job, requestTallyLine(this.#requests));
      this.appendLog(job, `${error instanceof Error ? error.message : String(error)}\n`);
      const details = await this.command(
        [
          `grep -h '"type":"error"' ${WRANGLER_OUTPUT} 2>/dev/null | tail -n 5`,
          `latest=$(ls -t ${WRANGLER_LOG_DIR}/*.log 2>/dev/null | head -n 1)`,
          `[ -n "$latest" ] && grep -iE 'error|✘|fail|refus|status|code' "$latest" | tail -n 40`,
          'true',
        ].join('\n'),
        SHORT_TIMEOUT_MS,
      ).catch(() => null);
      if (details?.stdout.trim()) {
        this.appendLog(job, `\nWhat Wrangler recorded:\n${details.stdout.trim()}\n`);
      }
      throw new StepFailure(stage, failureSentence(stage));
    }
  }

  private appendLog(job: Job, text: string): void {
    const before = this.log(job.deploymentId) ?? '';
    this.ctx.storage.sql.exec(
      `INSERT INTO builder_logs (deployment_id, log, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(deployment_id) DO UPDATE SET log = excluded.log, updated_at = excluded.updated_at`,
      job.deploymentId,
      `${before}${text}`.slice(-MAX_LOG_CHARACTERS),
      Date.now(),
    );
  }

  private openGate(job: Job, workerName: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO builder_gate (singleton, deployment_id, org_project_id, worker_name) VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET deployment_id = excluded.deployment_id,
         org_project_id = excluded.org_project_id, worker_name = excluded.worker_name`,
      job.deploymentId,
      job.orgProjectId,
      workerName,
    );
  }

  private closeGate(): void {
    this.ctx.storage.sql.exec('DELETE FROM builder_gate');
    this.#deployToken = null;
  }

  private gate(): { deploymentId: string; orgProjectId: string; workerName: string } | null {
    const gate = first(
      this.ctx.storage.sql.exec<{ deployment_id: string; org_project_id: string; worker_name: string }>(
        'SELECT deployment_id, org_project_id, worker_name FROM builder_gate WHERE singleton = 1',
      ),
    );
    return gate
      ? { deploymentId: gate.deployment_id, orgProjectId: gate.org_project_id, workerName: gate.worker_name }
      : null;
  }

  /**
   * One request of the deploy step's Wrangler, sent on to Cloudflare with the account's token if it is one a deploy
   * of the gate's Worker may make; outside a deploy step, nothing. The token stays here.
   */
  async forwardDeployApi(request: Request, proxyKey: string): Promise<Response> {
    const started = Date.now();
    const response = await this.decideDeployApi(request, proxyKey);
    const ms = Date.now() - started;
    const tally = this.#requests;
    tally.count += 1;
    tally.ms += ms;
    if (!tally.slowest || ms > tally.slowest.ms) {
      tally.slowest = { line: `${request.method} ${new URL(request.url).pathname} → ${response.status}`, ms };
    }
    return response;
  }

  private async decideDeployApi(request: Request, proxyKey: string): Promise<Response> {
    const gate = this.gate();
    if (!gate || !this.isProxyKey(proxyKey)) {
      return DEPLOY_REFUSED('No deploy is running.');
    }
    const url = new URL(request.url);
    const decision = deployApiDecision(
      { method: request.method, pathname: url.pathname },
      { accountId: this.env.CLOUDFLARE_ACCOUNT_ID, workerName: gate.workerName },
    );
    const job = { deploymentId: gate.deploymentId, orgProjectId: gate.orgProjectId };
    const headers = new Headers(request.headers);
    for (const name of ['host', 'content-length', 'cf-connecting-ip', 'x-forwarded-for']) {
      headers.delete(name);
    }
    const upstream = `${CLOUDFLARE_API}${url.pathname}${url.search}`;
    switch (decision) {
      case 'refused':
        return DEPLOY_REFUSED('CloudChef does not let a deploy make this request.');
      // Bodies go on whole, with their length: Cloudflare's asset upload answers a streamed one with a 500.
      case 'as_sent':
        return fetch(
          upstream,
          withBody({ method: request.method, headers, redirect: 'manual' }, await wholeBody(request)),
        );
      case 'with_token':
        return this.sendWithToken(job, upstream, request.method, headers, await wholeBody(request));
      case 'check_database': {
        const databaseId = url.pathname.split('/').at(-2) ?? '';
        const refusal = await this.resourceRefusal(job, { databases: [databaseId], namespaces: [] });
        return refusal
          ? DEPLOY_REFUSED(refusal)
          : this.sendWithToken(job, upstream, request.method, headers, await request.arrayBuffer());
      }
      case 'check_new_resource': {
        const text = await request.text();
        const named = parseJson(text, z.looseObject({ name: z.string().optional(), title: z.string().optional() }));
        if (!named || isCloudChefResourceName(named.name ?? named.title ?? '')) {
          return DEPLOY_REFUSED('A project can’t make resources with CloudChef’s names.');
        }
        return this.sendWithToken(job, upstream, request.method, headers, text);
      }
      case 'check_bindings': {
        const checked = await this.checkedWorkerUpload(job, request, gate.workerName);
        if ('refusal' in checked) {
          return DEPLOY_REFUSED(checked.refusal);
        }
        if (checked.body instanceof FormData) {
          // Sent again as form data, with a boundary of its own.
          headers.delete('content-type');
        }
        return this.sendWithToken(job, upstream, request.method, headers, checked.body);
      }
    }
  }

  /** A Worker upload's settings, checked against `deployBindingsCheck` and the resources it binds by id. */
  private async checkedWorkerUpload(
    job: Pick<Job, 'deploymentId' | 'orgProjectId'>,
    request: Request,
    workerName: string,
  ): Promise<{ refusal: string } | { body: BodyInit | null }> {
    const unreadable = { refusal: 'CloudChef couldn’t read the Worker’s settings.' };
    const type = (request.headers.get('content-type') ?? '').toLowerCase();
    const settings: WorkerSettings[] = [];
    // What goes on is what was checked: the settings as parsed here, written out again.
    let body: BodyInit | null;
    if (type.startsWith('multipart/form-data')) {
      const form = await request.formData();
      for (const part of ['metadata', 'settings']) {
        const values = form.getAll(part);
        if (values.length > 1) {
          return unreadable;
        }
        const value = values[0];
        if (value !== undefined) {
          const parsed = parseJson(value instanceof File ? await value.text() : value, workerSettingsSchema);
          if (parsed === undefined) {
            return unreadable;
          }
          settings.push(parsed);
          // In the same form it came: a plain field, or a file part with its name and type.
          if (value instanceof File) {
            form.set(part, new File([JSON.stringify(parsed)], value.name, { type: value.type }));
          } else {
            form.set(part, JSON.stringify(parsed));
          }
        }
      }
      body = form;
    } else if (type.startsWith('application/json')) {
      const parsed = parseJson(await request.text(), workerSettingsSchema);
      if (parsed === undefined) {
        return unreadable;
      }
      settings.push(parsed);
      body = JSON.stringify(parsed);
    } else {
      // Anything else could carry settings this doesn't read: only an empty body goes on.
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 0) {
        return unreadable;
      }
      body = null;
    }
    const lookups: BindingLookups = { databases: [], namespaces: [] };
    for (const value of settings) {
      const checked = deployBindingsCheck(value, workerName);
      if ('refusal' in checked) {
        return checked;
      }
      lookups.databases.push(...checked.lookups.databases);
      lookups.namespaces.push(...checked.lookups.namespaces);
    }
    const refusal = await this.resourceRefusal(job, lookups);
    return refusal ? { refusal } : { body };
  }

  /** Why a D1 database or KV namespace, by id, can't be used: it is CloudChef's, or couldn't be looked up. */
  private async resourceRefusal(
    job: Pick<Job, 'deploymentId' | 'orgProjectId'>,
    lookups: BindingLookups,
  ): Promise<string | null> {
    const checks = [
      ...lookups.databases.map((id) => ({ path: `/d1/database/${id}`, field: 'name' as const })),
      ...lookups.namespaces.map((id) => ({ path: `/storage/kv/namespaces/${id}`, field: 'title' as const })),
    ];
    for (const check of checks) {
      if (!/^\/[a-z0-9/-]+$/i.test(check.path)) {
        return 'CloudChef couldn’t look up a resource the Worker uses.';
      }
      const response = await this.cloudflare(job, check.path);
      const found = parseJson(
        await response.text().catch(() => ''),
        z.object({ result: z.looseObject({ name: z.string().optional(), title: z.string().optional() }) }),
      );
      const name = found?.result[check.field];
      if (!response.ok || name === undefined) {
        return 'CloudChef couldn’t look up a resource the Worker uses.';
      }
      if (isCloudChefResourceName(name)) {
        return 'The project’s Worker can’t use CloudChef’s own databases or storage.';
      }
    }
    return null;
  }

  /** A read of the account's API with the deploy's token, by its path below the account. */
  private async cloudflare(job: Pick<Job, 'deploymentId' | 'orgProjectId'>, path: string): Promise<Response> {
    const token = await this.deployToken(job);
    return fetch(`${CLOUDFLARE_API}/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  private async sendWithToken(
    job: Pick<Job, 'deploymentId' | 'orgProjectId'>,
    upstream: string,
    method: string,
    headers: Headers,
    body: BodyInit | null,
  ): Promise<Response> {
    let token: string;
    try {
      token = await this.deployToken(job);
    } catch {
      return DEPLOY_REFUSED('This deploy may not publish any more.');
    }
    headers.set('authorization', `Bearer ${token}`);
    return fetch(upstream, withBody({ method, headers, redirect: 'manual' }, body));
  }

  /** The account's token for the running deploy step, which the control plane gives only while it runs. */
  private async deployToken(job: Pick<Job, 'deploymentId' | 'orgProjectId'>): Promise<string> {
    const cached = this.#deployToken;
    if (cached?.deploymentId === job.deploymentId && Date.now() - cached.at < TOKEN_REUSE_MS) {
      return cached.token;
    }
    const token = await projectDeploymentCredential(this.env, this.identity(), {
      orgProjectId: job.orgProjectId,
      deploymentId: job.deploymentId,
    });
    this.#deployToken = { deploymentId: job.deploymentId, token, at: Date.now() };
    return token;
  }

  /** The repository the running job's source proxy reads. */
  sourceRepository(proxyKey: string): { repo: string } | null {
    if (!this.isProxyKey(proxyKey)) {
      return null;
    }
    const row = first(
      this.ctx.storage.sql.exec<{ repo: string }>(
        "SELECT repo FROM builder_jobs WHERE status = 'running' AND step = 'prepare' LIMIT 1",
      ),
    );
    return row ?? null;
  }

  private isProxyKey(proxyKey: string): boolean {
    const stored = first(
      this.ctx.storage.sql.exec<{ key: string }>('SELECT key FROM builder_proxy_key WHERE singleton = 1'),
    );
    return stored?.key === proxyKey;
  }

  private identity() {
    const identity = runtimeConnectionIdentity(this.env);
    if (!identity) {
      throw new Error('This workspace is not connected to CloudChef.');
    }
    return identity;
  }
}

function toJob(row: JobRow): Job {
  const plan = row.plan ? parseJson(row.plan, planSchema) : undefined;
  return {
    deploymentId: row.deployment_id,
    orgProjectId: row.org_project_id,
    repo: row.repo,
    branch: row.branch,
    commit: row.commit_sha,
    kind: row.kind,
    recordedWorker: row.recorded_worker,
    step: row.step,
    restarts: row.restarts,
    waits: row.waits,
    plan: plan ?? null,
    workerName: row.worker_name,
    nameTaken: row.name_taken === 1,
    deployConfig: row.deploy_config,
    migrated: row.migrated,
  };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

const wranglerConfigSchema = z.looseObject({
  build: z.unknown().optional(),
  main: z.string().optional(),
  base_dir: z.string().optional(),
  assets: z.looseObject({ directory: z.string().optional() }).optional(),
  d1_databases: z.array(z.looseObject({ migrations_dir: z.string().optional() })).optional(),
});

/** A Wrangler config's contents, from TOML or JSON with comments, or undefined when it can't be read. */
function readWranglerConfig(path: string, text: string) {
  try {
    const parsed = wranglerConfigSchema.safeParse(
      path.endsWith('.toml') ? parseToml(text) : JSON.parse(withoutJsonComments(text)),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** `text` as JSON of `schema`'s shape, or undefined when it is neither. */
function parseJson<T>(text: string, schema: z.ZodType<T>): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

type RequestTally = { count: number; ms: number; slowest: { line: string; ms: number } | null };

function emptyRequestTally(): RequestTally {
  return { count: 0, ms: 0, slowest: null };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** How many requests Wrangler sent Cloudflare through the deploy proxy, how long they took, and the slowest. */
function requestTallyLine(tally: RequestTally): string {
  const slowest = tally.slowest ? `, slowest ${tally.slowest.line} in ${seconds(tally.slowest.ms)}` : '';
  return `\n[${tally.count} requests to Cloudflare, ${seconds(tally.ms)} in all${slowest}]\n`;
}

/** A request's body read in full, or null for none. */
async function wholeBody(request: Request): Promise<ArrayBuffer | null> {
  return request.body ? request.arrayBuffer() : null;
}

function withBody(init: RequestInit, body: BodyInit | null): RequestInit {
  if (body !== null) {
    init.body = body;
  }
  return init;
}

/** A file only the job's own container has, marking that its earlier steps ran there. */
function jobMarker(job: Job): string {
  return `/opt/cloudchef/job-${job.deploymentId}`;
}

/** A preview alias Cloudflare accepts: the branch's words, lowercase, short enough for a hostname. */
function previewAlias(branch: string): string {
  return (
    branch
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'preview'
  );
}

type BuilderProxyProps = { builderId: string; proxyKey: string };
type BuilderProxy = (options: { props: BuilderProxyProps }) => Fetcher;

type BuilderExports = { BuilderSourceProxy: BuilderProxy; DeployApiProxy: BuilderProxy };

function builderExports(exports: Cloudflare.Exports): BuilderExports {
  if (!('BuilderSourceProxy' in exports) || !('DeployApiProxy' in exports)) {
    throw new Error('The workspace runtime is missing its BuilderSourceProxy or DeployApiProxy export.');
  }
  // SAFETY: the platform types loopback exports as `unknown`; these are the BuilderSourceProxy and DeployApiProxy
  // WorkerEntrypoint bindings, callable as `Proxy({ props })` to mint a Fetcher.
  return {
    BuilderSourceProxy: exports.BuilderSourceProxy as BuilderProxy,
    DeployApiProxy: exports.DeployApiProxy as BuilderProxy,
  };
}

const wranglerEventSchema = z.looseObject({
  type: z.string().optional(),
  targets: z.array(z.string()).optional(),
  preview_alias_url: z.string().optional(),
  preview_url: z.string().optional(),
});

/** The address a deploy reports in Wrangler's output: production's first target, or the preview's. */
function deployedUrl(ndjson: string, kind: 'production' | 'preview'): string | null {
  for (const line of ndjson.split('\n').reverse()) {
    const event = parseJson(line, wranglerEventSchema);
    if (!event) {
      continue;
    }
    if (kind === 'production' && event.type === 'deploy' && event.targets?.[0]) {
      const target = event.targets[0];
      return target.startsWith('http') ? target : `https://${target}`;
    }
    if (kind === 'preview' && event.type === 'version-upload') {
      return event.preview_alias_url ?? event.preview_url ?? null;
    }
  }
  return null;
}

function failureSentence(stage: string): string {
  switch (stage) {
    case 'install':
      return "Installing the project's packages failed.";
    case 'build':
      return "The project's build failed.";
    case 'migrations':
      return "Applying the project's database migrations failed, so the new version isn't live.";
    default:
      return 'Publishing to Cloudflare failed.';
  }
}

/** Git for the build container: read-only, the running job's repository only, with a token the container never sees. */
export class BuilderSourceProxy extends WorkerEntrypoint<BuilderEnv, BuilderProxyProps> {
  override fetch(request: Request): Promise<Response> {
    const namespace = this.env.PROJECT_BUILDER;
    const builder = namespace.get(namespace.idFromString(this.ctx.props.builderId));
    const repositories = new ProjectRepositories(this.env.ARTIFACTS);
    return handleGitProxyRequest(request, {
      repository: async () => {
        const source = await builder.sourceRepository(this.ctx.props.proxyKey);
        return source ? { repo: source.repo, orgProjectId: null, base: { branch: 'main', commit: null } } : null;
      },
      author: async () => ({ name: 'CloudChef', email: 'builds@cloudchef.build' }),
      refusal: async (_target, write) => (write ? 'Building reads the project; it never changes it.' : null),
      access: (repo, scope) => repositories.gitAccess(repo, scope),
      revoke: (repo, tokenId) => repositories.revokeToken(repo, tokenId),
      // Never asked: a push is refused above.
      isAncestor: async () => false,
      // A namespace no workspace has: the build sees branches and tags only.
      workspaceRefs: workspaceRefsPrefix(this.ctx.props.builderId),
      recordPush: async () => undefined,
      recordBase: async () => undefined,
      fetch: (input, init) => fetch(input, init),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
  }
}

/** Cloudflare's API for the build container's deploy step: every request goes to the builder, which decides. */
export class DeployApiProxy extends WorkerEntrypoint<BuilderEnv, BuilderProxyProps> {
  override fetch(request: Request): Promise<Response> {
    const namespace = this.env.PROJECT_BUILDER;
    return namespace
      .get(namespace.idFromString(this.ctx.props.builderId))
      .forwardDeployApi(request, this.ctx.props.proxyKey);
  }
}
