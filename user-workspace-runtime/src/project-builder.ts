import { WorkerEntrypoint } from 'cloudflare:workers';
import { Sandbox, type SandboxCommand } from '@cloudflare/sandbox';
import { createExtensionProcessSandbox } from '@cloudflare/sandbox/extensions';
import { z } from 'zod';
import { runtimeConnectionIdentity } from '../../app/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import { deployApiDecision } from '../../app/lib/.server/cloudflare/deploy-api-policy';
import { GIT_PROXY_HOST, handleGitProxyRequest } from '../../app/lib/.server/cloudflare/git-proxy';
import {
  claimProjectDeployment,
  projectDeploymentCredential,
  reportProjectDeployment,
  retryProjectDeployment,
} from '../../app/lib/.server/cloudflare/linked-project-client';
import {
  BUILD_PLAN_FILES,
  buildPlan,
  deployWorkerName,
  type BuildPlan,
} from '../../app/lib/.server/cloudflare/project-build-plan';
import { ProjectRepositories } from '../../app/lib/.server/cloudflare/project-repository';
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
 *   3. stop every process of that user, then deploy with CloudChef's own Wrangler through a proxy that adds the
 *      account's authorization only while the control plane says this deploy is running, and only to requests a
 *      deploy of this one Worker makes (`deployApiDecision`);
 *   4. report how it went, keeping the log here, in the person's own account.
 */

/** CloudChef's own Wrangler, which deploys; the project's own copy only ever builds. */
const WRANGLER_VERSION = '4.151.3';
const WRANGLER_ROOT = '/opt/cloudchef/wrangler';
const WRANGLER = `${WRANGLER_ROOT}/node_modules/.bin/wrangler`;
const WORK_DIR = '/work';
const BUILD_USER = 'build';
const BUILD_UID = 1001;
/** The deploy's own address for Cloudflare's API, which the deploy proxy answers. */
const DEPLOY_API_HOST = 'cloudflare-api.internal';
const WRANGLER_OUTPUT = '/tmp/wrangler-output.ndjson';

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 15 * 60_000;
const DEPLOY_TIMEOUT_MS = 10 * 60_000;
const SHORT_TIMEOUT_MS = 2 * 60_000;
const MAX_LOG_CHARACTERS = 64 * 1024;
const KEPT_LOGS = 10;

type BuilderEnv = {
  PROJECT_BUILDER: DurableObjectNamespace<ProjectBuilder>;
  ARTIFACTS: Artifacts;
  CONTROL_PLANE_SECRET: string;
  CLOUDCHEF_CONTROL_PLANE_ENDPOINT: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDCHEF_USER_ID: string;
  CLOUDCHEF_CONNECTION_ID: string;
  CLOUDCHEF_CONNECTION_GENERATION: string;
  CLOUDCHEF_USER_RUNTIME: string;
};

type Job = {
  deploymentId: string;
  orgProjectId: string;
  repo: string;
  branch: string;
  commit: string;
  kind: 'production' | 'preview';
  recordedWorker: string | null;
};

const jobSchema = z.object({
  orgProjectId: z.string().uuid(),
  branch: z.string().regex(/^[A-Za-z0-9._/-]{1,255}$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
});

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

export class ProjectBuilder extends Sandbox<BuilderEnv> {
  override sleepAfter = '5m';
  private readonly processes = createExtensionProcessSandbox(this);
  /** The deploy proxy's token, fetched once per deploy step. */
  #deployToken: { deploymentId: string; token: string } | null = null;

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
      created_at INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS builder_logs (
      deployment_id TEXT PRIMARY KEY,
      log TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    // Which deploy, of which Worker, may send requests through the deploy proxy now: none, outside a deploy step.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS builder_gate (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      deployment_id TEXT NOT NULL,
      org_project_id TEXT NOT NULL,
      worker_name TEXT NOT NULL
    )`);
  }

  /**
   * Builds and deploys `commit` of `branch` once the control plane hands it to this runtime: the first time it is
   * asked for that commit. A later ask for a commit already claimed does nothing.
   */
  async enqueue(value: { orgProjectId: string; branch: string; commit: string }): Promise<{ queued: boolean }> {
    const request = jobSchema.parse(value);
    const identity = this.identity();
    const claimed = await claimProjectDeployment(this.env, identity, request);
    if (!claimed.claimed) {
      return { queued: false };
    }
    this.addJob({
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

  /** Starts a failed deploy again, as a new attempt of the same commit. */
  async retry(value: { orgProjectId: string; deploymentId: string }): Promise<{ deploymentId: string }> {
    const identity = this.identity();
    const retried = await retryProjectDeployment(this.env, identity, value);
    const claimed = await claimProjectDeployment(this.env, identity, {
      orgProjectId: value.orgProjectId,
      branch: retried.branch,
      commit: retried.commit,
    });
    this.ctx.storage.sql.exec('DELETE FROM builder_jobs WHERE deployment_id = ?', retried.deploymentId);
    this.addJob({
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

  private addJob(job: Job): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO builder_jobs (deployment_id, org_project_id, repo, branch, commit_sha, kind, recorded_worker, status,
         created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(deployment_id) DO NOTHING`,
      job.deploymentId,
      job.orgProjectId,
      job.repo,
      job.branch,
      job.commit,
      job.kind,
      job.recordedWorker,
      Date.now(),
    );
    this.ctx.waitUntil(this.schedule(0, 'runNext', {}));
  }

  /** Runs the oldest waiting job, then the next: one at a time, each in a fresh container. */
  async runNext(): Promise<void> {
    // A job left running by an eviction starts over from a fresh container; each step can be repeated.
    this.ctx.storage.sql.exec("UPDATE builder_jobs SET status = 'pending' WHERE status = 'running'");
    const row = first(
      this.ctx.storage.sql.exec<{
        deployment_id: string;
        org_project_id: string;
        repo: string;
        branch: string;
        commit_sha: string;
        kind: 'production' | 'preview';
        recorded_worker: string | null;
      }>(
        `SELECT deployment_id, org_project_id, repo, branch, commit_sha, kind, recorded_worker FROM builder_jobs
         WHERE status = 'pending' ORDER BY created_at LIMIT 1`,
      ),
    );
    if (!row) {
      return;
    }
    const job: Job = {
      deploymentId: row.deployment_id,
      orgProjectId: row.org_project_id,
      repo: row.repo,
      branch: row.branch,
      commit: row.commit_sha,
      kind: row.kind,
      recordedWorker: row.recorded_worker,
    };
    this.ctx.storage.sql.exec("UPDATE builder_jobs SET status = 'running' WHERE deployment_id = ?", job.deploymentId);
    try {
      await this.run(job);
    } finally {
      this.closeGate();
      this.ctx.storage.sql.exec("UPDATE builder_jobs SET status = 'done' WHERE deployment_id = ?", job.deploymentId);
      this.ctx.storage.sql.exec(
        `DELETE FROM builder_logs WHERE deployment_id NOT IN (
           SELECT deployment_id FROM builder_logs ORDER BY updated_at DESC LIMIT ?)`,
        KEPT_LOGS,
      );
      await this.destroy().catch(() => undefined);
      await this.schedule(0, 'runNext', {});
    }
  }

  private async run(job: Job): Promise<void> {
    const report = (state: Parameters<typeof reportProjectDeployment>[2]) =>
      reportProjectDeployment(this.env, this.identity(), state);
    const plan = await this.plan(job);
    if (!plan.deployable) {
      await report({
        orgProjectId: job.orgProjectId,
        deploymentId: job.deploymentId,
        state: 'not_deployable',
        reason: plan.reason,
      });
      return;
    }
    try {
      await this.step(report({ orgProjectId: job.orgProjectId, deploymentId: job.deploymentId, state: 'building' }));
      await this.prepareContainer();
      await this.asBuildUser(job, 'install', fetchCommand(job), SHORT_TIMEOUT_MS, 'install');
      await this.asBuildUser(job, 'install', plan.install, INSTALL_TIMEOUT_MS, 'install');
      for (const command of [plan.build, plan.configBuild]) {
        if (command) {
          await this.asBuildUser(job, 'build', command, BUILD_TIMEOUT_MS, 'build');
        }
      }
      await this.root(job, 'build', endBuildPhase(), SHORT_TIMEOUT_MS);
      await this.step(report({ orgProjectId: job.orgProjectId, deploymentId: job.deploymentId, state: 'deploying' }));
      const worker = await this.chooseWorker(job, plan);
      this.openGate(job, worker.name);
      const url = await this.deploy(job, plan, worker.name);
      const succeeded: Parameters<typeof reportProjectDeployment>[2] = {
        orgProjectId: job.orgProjectId,
        deploymentId: job.deploymentId,
        state: 'succeeded',
        workerName: worker.name,
      };
      if (url) {
        succeeded.url = url;
      }
      if (worker.nameTaken) {
        succeeded.reason = `A Worker named ${plan.workerName} was already in the account, so this went to ${worker.name}.`;
      }
      await report(succeeded);
    } catch (error) {
      if (error instanceof StepAbandoned) {
        return;
      }
      const failure =
        error instanceof StepFailure ? error : new StepFailure('interrupted', 'The deploy stopped partway.');
      this.appendLog(job, `\n${failure.message}\n`);
      await report({
        orgProjectId: job.orgProjectId,
        deploymentId: job.deploymentId,
        state: 'failed',
        failureStage: failure.stage,
        reason: failure.message,
      }).catch(() => undefined);
    }
  }

  /** A report that says to stop (superseded, or not this runtime's) ends the job quietly. */
  private async step(outcome: Promise<'recorded' | 'superseded' | 'refused'>): Promise<void> {
    if ((await outcome) !== 'recorded') {
      throw new StepAbandoned();
    }
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

  /** A fresh container with the build user, CloudChef's Wrangler, and the two proxies it reaches the world through. */
  private async prepareContainer(): Promise<void> {
    await this.destroy().catch(() => undefined);
    await this.start();
    const exports = builderExports(this.ctx.exports);
    const props = { props: { builderId: this.ctx.id.toString() } };
    await this.ctx.container!.interceptOutboundHttp(GIT_PROXY_HOST, exports.BuilderSourceProxy(props));
    await this.ctx.container!.interceptOutboundHttp(DEPLOY_API_HOST, exports.DeployApiProxy(props));
    await this.command(
      [
        'set -eu',
        `id -u ${BUILD_USER} >/dev/null 2>&1 || useradd --uid ${BUILD_UID} --create-home ${BUILD_USER}`,
        `mkdir -p ${WORK_DIR} && chown ${BUILD_USER}:${BUILD_USER} ${WORK_DIR}`,
        `[ -x ${WRANGLER} ] || npm install --prefix ${WRANGLER_ROOT} wrangler@${WRANGLER_VERSION} --ignore-scripts --no-audit --no-fund --loglevel=error`,
        'command -v pnpm >/dev/null 2>&1 || npm install --global pnpm --ignore-scripts --no-audit --no-fund --loglevel=error',
        'corepack enable >/dev/null 2>&1 || true',
      ].join('\n'),
      SHORT_TIMEOUT_MS * 2,
    );
  }

  private async asBuildUser(
    job: Job,
    stage: 'install' | 'build',
    command: string,
    timeout: number,
    label: string,
  ): Promise<void> {
    const wrapped =
      `setpriv --reuid=${BUILD_UID} --regid=${BUILD_UID} --clear-groups --no-new-privs -- ` +
      `env -i HOME=/home/${BUILD_USER} PATH=/usr/local/bin:/usr/bin:/bin CI=1 ` +
      `sh -c ${shellQuote(`cd ${WORK_DIR} && ${command}`)}`;
    await this.logged(job, stage, wrapped, timeout, `$ ${command}`, label);
  }

  private async root(
    job: Job,
    stage: 'build' | 'deploy' | 'migrations',
    command: string,
    timeout: number,
  ): Promise<void> {
    await this.logged(job, stage, command, timeout, null, stage);
  }

  private async logged(
    job: Job,
    stage: 'install' | 'build' | 'deploy' | 'migrations',
    command: string,
    timeout: number,
    heading: string | null,
    label: string,
  ): Promise<string> {
    if (heading) {
      this.appendLog(job, `\n${heading}\n`);
    }
    try {
      const output = await this.command(command, timeout);
      this.appendLog(job, `${output.stdout}${output.stderr}`);
      return output.stdout;
    } catch (error) {
      this.appendLog(job, `${error instanceof Error ? error.message : String(error)}\n`);
      throw new StepFailure(stage, failureSentence(label));
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

  /** The Worker this deploy goes to: the one it went to before, else its config's name if free, else a free one. */
  private async chooseWorker(job: Job, plan: Extract<BuildPlan, { deployable: true }>) {
    if (job.recordedWorker) {
      return { name: job.recordedWorker, nameTaken: false };
    }
    const token = await this.deployToken(job);
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/services/${plan.workerName}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    await response.body?.cancel().catch(() => undefined);
    return deployWorkerName({
      recorded: null,
      configName: plan.workerName,
      projectId: job.orgProjectId,
      configNameTaken: response.status === 200,
    });
  }

  /** Applies the config's D1 migrations, then deploys (main) or uploads a preview (another branch). */
  private async deploy(
    job: Job,
    plan: Extract<BuildPlan, { deployable: true }>,
    workerName: string,
  ): Promise<string | null> {
    const env = {
      CLOUDFLARE_API_BASE_URL: `http://${DEPLOY_API_HOST}/client/v4`,
      // Wrangler needs a token to run unattended; the deploy proxy puts the real one in place of this.
      CLOUDFLARE_API_TOKEN: 'cloudchef-deploy-proxy',
      CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_OUTPUT_FILE_PATH: WRANGLER_OUTPUT,
      CI: '1',
    };
    const config = plan.configBuild ? 'wrangler.cloudchef.json' : null;
    if (config) {
      // The build command already ran as the build user; the deploy runs none.
      await this.root(job, 'deploy', withoutBuildCommand(plan.configFile, config), SHORT_TIMEOUT_MS);
    }
    const configFlag = config ? ` --config ${config}` : '';
    if (job.kind === 'production') {
      for (const database of plan.migrations) {
        this.appendLog(job, `\n$ wrangler d1 migrations apply ${database.databaseName} --remote\n`);
        await this.runWrangler(
          job,
          'migrations',
          `d1 migrations apply ${shellQuote(database.databaseName)} --remote${configFlag}`,
          env,
        );
      }
    }
    const command =
      job.kind === 'production'
        ? `deploy --name ${workerName}${configFlag}`
        : `versions upload --name ${workerName} --preview-alias ${previewAlias(job.branch)}${configFlag}`;
    this.appendLog(job, `\n$ wrangler ${command}\n`);
    await this.runWrangler(job, 'deploy', command, env);
    const output = await this.command(`cat ${WRANGLER_OUTPUT} 2>/dev/null || true`, SHORT_TIMEOUT_MS);
    return deployedUrl(output.stdout, job.kind);
  }

  private async runWrangler(
    job: Job,
    stage: 'deploy' | 'migrations',
    args: string,
    env: Record<string, string>,
  ): Promise<void> {
    try {
      const output = await this.command(`cd ${WORK_DIR} && ${WRANGLER} ${args}`, DEPLOY_TIMEOUT_MS, env);
      this.appendLog(job, `${output.stdout}${output.stderr}`);
    } catch (error) {
      this.appendLog(job, `${error instanceof Error ? error.message : String(error)}\n`);
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

  /** What the deploy proxy may send now: nothing outside a deploy step. */
  deployGate(): { deploymentId: string; orgProjectId: string; workerName: string; accountId: string } | null {
    const gate = first(
      this.ctx.storage.sql.exec<{ deployment_id: string; org_project_id: string; worker_name: string }>(
        'SELECT deployment_id, org_project_id, worker_name FROM builder_gate WHERE singleton = 1',
      ),
    );
    return gate
      ? {
          deploymentId: gate.deployment_id,
          orgProjectId: gate.org_project_id,
          workerName: gate.worker_name,
          accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
        }
      : null;
  }

  /** The account's token for the running deploy step, which the control plane gives only while it runs. */
  async deployTokenFor(deploymentId: string, forceRefresh = false): Promise<string | null> {
    const gate = this.deployGate();
    if (!gate || gate.deploymentId !== deploymentId) {
      return null;
    }
    if (!forceRefresh && this.#deployToken?.deploymentId === deploymentId) {
      return this.#deployToken.token;
    }
    const token = await projectDeploymentCredential(this.env, this.identity(), {
      orgProjectId: gate.orgProjectId,
      deploymentId,
      forceRefresh,
    });
    this.#deployToken = { deploymentId, token };
    return token;
  }

  private async deployToken(job: Job): Promise<string> {
    const token = await projectDeploymentCredential(this.env, this.identity(), {
      orgProjectId: job.orgProjectId,
      deploymentId: job.deploymentId,
    });
    this.#deployToken = { deploymentId: job.deploymentId, token };
    return token;
  }

  /** The repository the running job's source proxy reads. */
  sourceRepository(): { repo: string } | null {
    const row = first(
      this.ctx.storage.sql.exec<{ repo: string }>("SELECT repo FROM builder_jobs WHERE status = 'running' LIMIT 1"),
    );
    return row ?? null;
  }

  private identity() {
    const identity = runtimeConnectionIdentity(this.env);
    if (!identity) {
      throw new Error('This workspace is not connected to CloudChef.');
    }
    return identity;
  }
}

/** Fetches exactly the commit into the work folder, through the read-only source proxy. */
function fetchCommand(job: Job): string {
  return [
    'git init -q .',
    `git fetch -q --depth=1 http://${GIT_PROXY_HOST}/project.git ${job.commit} 2>/dev/null ||`,
    `  git fetch -q --depth=1 http://${GIT_PROXY_HOST}/project.git ${shellQuote(job.branch)}`,
    `[ "$(git rev-parse FETCH_HEAD)" = ${job.commit} ] || { echo 'The branch moved on since this commit.' >&2; exit 1; }`,
    'git checkout -q FETCH_HEAD',
  ].join(' ');
}

/** Stops every process the build left, checks none is left, and takes the files away from the build user. */
function endBuildPhase(): string {
  return [
    'set -eu',
    `pkill -KILL -u ${BUILD_USER} || true`,
    'sleep 1',
    `if pgrep -u ${BUILD_USER} >/dev/null; then echo 'The build left processes running.' >&2; exit 1; fi`,
    // Local secrets never go to Cloudflare, and Wrangler would read them.
    `find ${WORK_DIR} -maxdepth 1 \\( -name '.env' -o -name '.env.*' -o -name '.dev.vars' -o -name '.dev.vars.*' \\) -delete`,
    `chown -R root:root ${WORK_DIR}`,
  ].join('\n');
}

/** The project's Wrangler config without its build command, for a deploy that runs none. */
function withoutBuildCommand(configFile: string, out: string): string {
  const script = [
    "const fs = require('fs');",
    `const text = fs.readFileSync(${JSON.stringify(configFile)}, 'utf8');`,
    `const config = ${JSON.stringify(configFile)}.endsWith('.toml')`,
    `  ? require(${JSON.stringify(`${WRANGLER_ROOT}/node_modules/smol-toml`)}).parse(text)`,
    "  : JSON.parse(text.replace(/\\/\\*[\\s\\S]*?\\*\\/|(^|[^:\\\\])\\/\\/.*$/gm, '$1').replace(/,(\\s*[}\\]])/g, '$1'));",
    'delete config.build;',
    `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(config));`,
  ].join('\n');
  return `cd ${WORK_DIR} && node -e ${shellQuote(script)}`;
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

type BuilderProxy = (options: { props: { builderId: string } }) => Fetcher;

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
    try {
      const event = wranglerEventSchema.parse(JSON.parse(line));
      if (kind === 'production' && event.type === 'deploy' && event.targets?.[0]) {
        return event.targets[0].startsWith('http') ? event.targets[0] : `https://${event.targets[0]}`;
      }
      if (kind === 'preview' && event.type === 'version-upload') {
        return event.preview_alias_url ?? event.preview_url ?? null;
      }
    } catch {
      // Not every line is an event.
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
export class BuilderSourceProxy extends WorkerEntrypoint<BuilderEnv, { builderId: string }> {
  override fetch(request: Request): Promise<Response> {
    const namespace = this.env.PROJECT_BUILDER;
    const builder = namespace.get(namespace.idFromString(this.ctx.props.builderId));
    const repositories = new ProjectRepositories(this.env.ARTIFACTS);
    return handleGitProxyRequest(request, {
      repository: async () => {
        const source = await builder.sourceRepository();
        return source ? { repo: source.repo, orgProjectId: null, base: { branch: 'main', commit: null } } : null;
      },
      author: async () => ({ name: 'CloudChef', email: 'builds@cloudchef.build' }),
      refusal: async (_target, write) => (write ? 'Building reads the project; it never changes it.' : null),
      access: (repo, scope) => repositories.gitAccess(repo, scope),
      revoke: (repo, tokenId) => repositories.revokeToken(repo, tokenId),
      recordPush: async () => undefined,
      recordBase: async () => undefined,
      fetch: (input, init) => fetch(input, init),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
  }
}

/**
 * Cloudflare's API for the build container's deploy step: what a deploy of the gate's Worker may ask, sent on with the
 * account's token in place of the placeholder Wrangler holds; outside a deploy step, nothing.
 */
export class DeployApiProxy extends WorkerEntrypoint<BuilderEnv, { builderId: string }> {
  override async fetch(request: Request): Promise<Response> {
    const namespace = this.env.PROJECT_BUILDER;
    const builder = namespace.get(namespace.idFromString(this.ctx.props.builderId));
    const gate = await builder.deployGate();
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/client\/v4/, '');
    const decision = gate
      ? deployApiDecision({ method: request.method, path }, { accountId: gate.accountId, workerName: gate.workerName })
      : 'refused';
    if (!gate || decision === 'refused') {
      return Response.json(
        { success: false, errors: [{ code: 10000, message: 'CloudChef does not let a deploy make this request.' }] },
        { status: 403 },
      );
    }
    const headers = new Headers(request.headers);
    headers.delete('host');
    const send = async (token: string | null) => {
      if (token) {
        headers.set('authorization', `Bearer ${token}`);
      }
      const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers, redirect: 'manual' };
      if (request.body) {
        init.body = request.body;
        init.duplex = 'half';
      }
      return fetch(`https://api.cloudflare.com${url.pathname}${url.search}`, init);
    };
    if (decision === 'as_sent') {
      return send(null);
    }
    const token = await builder.deployTokenFor(gate.deploymentId);
    if (!token) {
      return Response.json(
        { success: false, errors: [{ code: 10000, message: 'No deploy is running.' }] },
        { status: 403 },
      );
    }
    return send(token);
  }
}
