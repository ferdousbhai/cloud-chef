import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runValidation, VALIDATION_TASKS, validationConcurrency } from './validate.mjs';

const scripts = z
  .object({ scripts: z.record(z.string(), z.string()) })
  .parse(JSON.parse(readFileSync('package.json', 'utf8'))).scripts;

/** A script expanded through every `pnpm run <script>` step it chains, down to the commands that do the work. */
function leafSteps(command: string): string[] {
  return command.split(' && ').flatMap((step) => {
    const nested = /^pnpm run ([\w:-]+)$/.exec(step.trim())?.[1];
    return nested !== undefined && scripts[nested] !== undefined ? leafSteps(scripts[nested]) : [step.trim()];
  });
}

function taskSteps(args: readonly string[]): string[] {
  if (args[0] === 'run' && args.length === 2) {
    return leafSteps(scripts[args[1]!]!);
  }
  if (args[0] === 'exec') {
    return [args.slice(1).join(' ')];
  }
  return [`pnpm ${args.join(' ')}`];
}

describe('parallel validation', () => {
  it('runs exactly the steps of the serial validation scripts, each once', () => {
    const serial = [
      ...leafSteps(scripts['validate:root']!),
      ...leafSteps(scripts['validate:agent']!),
      // The template profiles run as separate processes; with no flag the script runs all three.
      ...['--web-only', '--agent-only', '--worker-only'].map((flag) => `${scripts['validate:template']} ${flag}`),
    ];
    const parallel = VALIDATION_TASKS.flatMap(({ args }) => taskSteps(args));

    expect(scripts.validate).toBe('node scripts/validate.mjs');
    expect([...parallel].sort()).toEqual([...serial].sort());
  });

  it('orders every root check after generate and every built-output check after the build', () => {
    const byName = new Map(VALIDATION_TASKS.map((task) => [task.name, task]));
    for (const task of VALIDATION_TASKS) {
      if (task.args[0] === 'run' && task.name !== 'generate') {
        expect(task.after?.length, task.name).toBeGreaterThan(0);
      }
    }
    for (const name of ['verify:built-ssr', 'verify:static-assets', 'bundle:check']) {
      expect(byName.get(name)?.after).toEqual(['build:check']);
    }
    expect(byName.get('build:check')?.after).toEqual(['generate']);
  });

  it('waits for dependencies, honours the concurrency limit, and stops everything on the first failure', async () => {
    const events: string[] = [];
    let active = 0;
    let peak = 0;
    const stopped: string[] = [];
    const releases = new Map<string, (code: number) => void>();
    const run = (task: { name: string }) => {
      events.push(`start ${task.name}`);
      active += 1;
      peak = Math.max(peak, active);
      return {
        done: new Promise<{ code: number; output: string }>((resolve) => {
          releases.set(task.name, (code) => {
            active -= 1;
            resolve({ code, output: `${task.name} output` });
          });
        }),
        stop: () => {
          stopped.push(task.name);
          releases.get(task.name)?.(143);
        },
      };
    };
    const lines: string[] = [];
    const result = runValidation({
      tasks: [
        { name: 'generate', args: [] },
        { name: 'slow', args: [] },
        { name: 'typecheck', args: [], after: ['generate'] },
        { name: 'test', args: [], after: ['generate'] },
      ],
      concurrency: 2,
      run,
      log: (line) => lines.push(line),
      now: () => 0,
    });

    expect(events).toEqual(['start generate', 'start slow']);
    releases.get('generate')!(0);
    await Promise.resolve();
    expect(events).toEqual(['start generate', 'start slow', 'start typecheck']);
    releases.get('typecheck')!(2);

    await expect(result).resolves.toMatchObject({ ok: false });
    expect(peak).toBe(2);
    expect(stopped).toEqual(['slow']);
    expect(events).not.toContain('start test');
    expect(lines.join('\n')).toContain('FAIL typecheck');
    expect(lines.join('\n')).toContain('typecheck output');
  });

  it('rejects a task list that waits on a task it does not contain', async () => {
    await expect(
      runValidation({ tasks: [{ name: 'test', args: [], after: ['generate'] }], log: () => undefined }),
    ).rejects.toThrow('unknown task "generate"');
  });

  it('runs one check per core unless told otherwise', () => {
    expect(validationConcurrency({ VALIDATE_CONCURRENCY: '3' })).toBe(3);
    expect(validationConcurrency({})).toBeGreaterThanOrEqual(2);
    expect(validationConcurrency({ VALIDATE_CONCURRENCY: 'many' })).toBeGreaterThanOrEqual(2);
  });
});
