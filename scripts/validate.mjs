/**
 * `pnpm run validate`: every check of the root project, the cloudchef-agent package, and the template
 * profiles, scheduled side by side.
 *
 * The checks are independent of each other apart from two orderings, which are the only edges here:
 * everything in the root project reads what `generate` writes (routes, Worker binding types, the
 * generated bundles), and the three built-output checks read what `build:check` writes. The
 * template profiles and the cloudchef-agent package read neither, so they start at once.
 *
 * Output is held per check and printed when it finishes, so parallel logs never interleave. The
 * first failure prints its full output, stops every check still running, and exits non-zero.
 */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Longest first within each wave, so the critical path starts earliest when the concurrency limit binds.
 * @type {ReadonlyArray<{ name: string; args: readonly string[]; after?: readonly string[] }>}
 */
export const VALIDATION_TASKS = Object.freeze([
  { name: 'template (web)', args: ['exec', 'node', 'scripts/verify-template.mjs', '--web-only'] },
  { name: 'template (agent)', args: ['exec', 'node', 'scripts/verify-template.mjs', '--agent-only'] },
  { name: 'template (worker)', args: ['exec', 'node', 'scripts/verify-template.mjs', '--worker-only'] },
  { name: 'generate', args: ['run', 'generate'] },
  { name: 'agent typecheck', args: ['--dir', 'cloudchef-agent', 'run', 'typecheck'] },
  { name: 'agent test', args: ['--dir', 'cloudchef-agent', 'run', 'test'] },
  { name: 'lint:code', args: ['run', 'lint:code'], after: ['generate'] },
  { name: 'typecheck:check', args: ['run', 'typecheck:check'], after: ['generate'] },
  { name: 'knip', args: ['run', 'knip'], after: ['generate'] },
  { name: 'build:check', args: ['run', 'build:check'], after: ['generate'] },
  { name: 'test', args: ['run', 'test'], after: ['generate'] },
  { name: 'lint:format', args: ['run', 'lint:format'], after: ['generate'] },
  { name: 'test:workerd', args: ['run', 'test:workerd'], after: ['generate'] },
  { name: 'test:builder-agent', args: ['run', 'test:builder-agent'], after: ['generate'] },
  { name: 'verify:licenses', args: ['run', 'verify:licenses'], after: ['generate'] },
  { name: 'audit:dependencies', args: ['run', 'audit:dependencies'], after: ['generate'] },
  { name: 'lint:oxlint', args: ['run', 'lint:oxlint'], after: ['generate'] },
  { name: 'verify:stack', args: ['run', 'verify:stack'], after: ['generate'] },
  { name: 'verify:production-config', args: ['run', 'verify:production-config'], after: ['generate'] },
  { name: 'verify:workers-builds-config', args: ['run', 'verify:workers-builds-config'], after: ['generate'] },
  { name: 'verify:copy-assertions', args: ['run', 'verify:copy-assertions'], after: ['generate'] },
  { name: 'bundle:check', args: ['run', 'bundle:check'], after: ['build:check'] },
  { name: 'verify:built-ssr', args: ['run', 'verify:built-ssr'], after: ['build:check'] },
  { name: 'verify:static-assets', args: ['run', 'verify:static-assets'], after: ['build:check'] },
]);

/**
 * Every check spawns its own workers (vitest, tsc, the template builds), so more than one check per
 * core only adds contention. `VALIDATE_CONCURRENCY` overrides it, e.g. `1` for the serial order.
 */
export function validationConcurrency(env = process.env) {
  const requested = Number.parseInt(env.VALIDATE_CONCURRENCY ?? '', 10);
  return Number.isSafeInteger(requested) && requested > 0 ? requested : Math.max(2, availableParallelism());
}

/**
 * @param {{
 *   tasks?: typeof VALIDATION_TASKS;
 *   concurrency?: number;
 *   run?: (task: (typeof VALIDATION_TASKS)[number]) => { done: Promise<{ code: number; output: string }>; stop: () => void };
 *   log?: (line: string) => void;
 *   now?: () => number;
 * }} [options]
 * @returns {Promise<{ ok: boolean; timings: Array<{ name: string; seconds: number }> }>}
 */
export async function runValidation({
  tasks = VALIDATION_TASKS,
  concurrency = validationConcurrency(),
  run = spawnTask,
  log = (line) => process.stdout.write(`${line}\n`),
  now = () => performance.now(),
} = {}) {
  const names = new Set(tasks.map(({ name }) => name));
  for (const task of tasks) {
    for (const dependency of task.after ?? []) {
      if (!names.has(dependency)) {
        throw new Error(`Validation task "${task.name}" waits for unknown task "${dependency}".`);
      }
    }
  }

  const started = now();
  const pending = [...tasks];
  const finished = new Set();
  const running = new Map();
  const timings = [];
  let failed = false;

  return await new Promise((resolveRun) => {
    const settle = () => {
      if (running.size > 0) {
        return;
      }
      if (failed || pending.length === 0) {
        log(`\nValidation ${failed ? 'failed' : 'passed'} in ${((now() - started) / 1000).toFixed(1)}s.`);
        resolveRun({ ok: !failed && pending.length === 0, timings });
        return;
      }
      // Nothing running and nothing startable: a cycle, which the task list must never contain.
      failed = true;
      log(`Validation tasks can never start: ${pending.map(({ name }) => name).join(', ')}.`);
      resolveRun({ ok: false, timings });
    };

    const startReady = () => {
      for (let index = 0; !failed && running.size < concurrency && index < pending.length;) {
        const task = pending[index];
        if (!(task.after ?? []).every((dependency) => finished.has(dependency))) {
          index += 1;
          continue;
        }
        pending.splice(index, 1);
        const taskStarted = now();
        const handle = run(task);
        running.set(task.name, handle);
        handle.done.then(({ code, output }) => {
          running.delete(task.name);
          const seconds = (now() - taskStarted) / 1000;
          timings.push({ name: task.name, seconds });
          if (code === 0) {
            finished.add(task.name);
            log(`ok   ${task.name} (${seconds.toFixed(1)}s)`);
          } else if (!failed) {
            failed = true;
            log(`FAIL ${task.name} (${seconds.toFixed(1)}s, exit ${code})\n${output.trimEnd()}`);
            for (const other of running.values()) {
              other.stop();
            }
          }
          startReady();
          settle();
        });
      }
    };

    startReady();
    settle();
  });
}

/** Every check still running, so an interrupt stops them too: they are not in the terminal's process group. */
const liveTasks = new Set();

/** @param {(typeof VALIDATION_TASKS)[number]} task */
function spawnTask(task) {
  // Its own process group, so stopping it also stops the tool processes pnpm started beneath it.
  const child = spawn('pnpm', task.args, { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already exited.
    }
  };
  liveTasks.add(stop);
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolveTask) => {
    child.once('error', (error) => resolveTask({ code: 1, output: error.message }));
    child.once('close', (code, signal) => {
      liveTasks.delete(stop);
      resolveTask({ code: code ?? (signal ? 1 : 0), output: Buffer.concat(chunks).toString('utf8') });
    });
  });
  return { done, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      for (const stop of liveTasks) {
        stop();
      }
      process.exit(130);
    });
  }
  const { ok } = await runValidation();
  process.exitCode = ok ? 0 : 1;
}
