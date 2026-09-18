import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { shellQuote } from './shell-quote';
import { STAGE_LOG_TAIL_BYTES, parallelValidationStagesCommand } from './validation-stages';

const scratch = mkdtempSync(join(tmpdir(), 'cloudchef-stages-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(stages: { name: string; command: string }[]) {
  const command = parallelValidationStagesCommand(stages, { logRoot: join(scratch, 'logs') });
  return spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
}

describe('parallel validation stages', () => {
  it('runs stages concurrently rather than end to end', () => {
    // Each stage announces itself, then exits successfully only once it has seen every other
    // stage's announcement. Sequential execution can never pass - the first stage would wait
    // out its bounded loop before the second stage ever started - and there is no wall-clock
    // assertion for a loaded CI machine to flake.
    const rendezvous = join(scratch, 'rendezvous');
    mkdirSync(rendezvous, { recursive: true });
    const everyMarker = ['a', 'b', 'c'].map((name) => `[ -e ${shellQuote(join(rendezvous, name))} ]`).join(' && ');
    const stage = (name: string) => ({
      name,
      command: `touch ${shellQuote(join(rendezvous, name))}; for i in $(seq 1 200); do if ${everyMarker}; then exit 0; fi; sleep 0.05; done; exit 1`,
    });

    const result = run([stage('a'), stage('b'), stage('c')]);

    expect(result.status).toBe(0);
  });

  it('fails the group and names every stage that failed', () => {
    const result = run([
      { name: 'passes', command: 'true' },
      { name: 'typecheck', command: 'echo "TS1005: expected" >&2; exit 2' },
      { name: 'lint', command: 'echo "no-unused-vars" >&2; exit 1' },
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('===== typecheck failed =====');
    expect(result.stderr).toContain('TS1005: expected');
    expect(result.stderr).toContain('===== lint failed =====');
    expect(result.stderr).toContain('no-unused-vars');
    expect(result.stderr).not.toContain('passes failed');
  });

  it('surfaces the end of a failing stage log, where the error is', () => {
    // A build that fails after printing megabytes must not push its own error out of the
    // bounded exec stream.
    const result = run([
      { name: 'noisy', command: `for i in $(seq 1 4000); do echo "line $i padding padding"; done; echo BOOM; exit 1` },
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BOOM');
    expect(result.stderr.length).toBeLessThan(STAGE_LOG_TAIL_BYTES + 2_000);
  });

  it('refuses a stage name that would not be a safe log file or shell word', () => {
    for (const name of ['../escape', 'has space', 'Upper', '']) {
      expect(() => parallelValidationStagesCommand([{ name, command: 'true' }], { logRoot: '/tmp/x' })).toThrow();
    }
  });

  it('refuses duplicate stage names that would share one log file', () => {
    expect(() =>
      parallelValidationStagesCommand(
        [
          { name: 'lint', command: 'true' },
          { name: 'lint', command: 'false' },
        ],
        { logRoot: '/tmp/x' },
      ),
    ).toThrow(/Duplicate/);
  });
});
