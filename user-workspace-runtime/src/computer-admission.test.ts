import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ComputerAdmissionControl, ComputerOperationsDisabledError } from './computer-admission';

describe('ComputerAdmissionControl', () => {
  it('fails new operations closed with the operator reason once the switch is thrown', async () => {
    const db = controlDatabase({ enabled: 0, reason: 'Computer 0.2.1 container startup is failing.' });
    const admission = new ComputerAdmissionControl(db.binding);

    await expect(admission.admitNewOperation()).rejects.toMatchObject({
      code: 'computer_operations_disabled',
      message: '[computer_operations_disabled] Computer 0.2.1 container startup is failing.',
    });
    await expect(admission.admitNewOperation()).rejects.toBeInstanceOf(ComputerOperationsDisabledError);
  });

  it('re-reads the control without a redeploy once the decision window elapses', async () => {
    const db = controlDatabase({ enabled: 1, reason: null });
    const admission = new ComputerAdmissionControl(db.binding);
    await admission.admitNewOperation(0);
    await admission.admitNewOperation(9_999);
    expect(db.reads).toBe(1);

    db.control = { enabled: 0, reason: null };
    await expect(admission.admitNewOperation(10_000)).rejects.toBeInstanceOf(ComputerOperationsDisabledError);
    expect(db.reads).toBe(2);
  });
});

describe('ProjectWorkspace admission', () => {
  const runtimeSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  // ProjectWorkspace needs a Container and Computer to construct, so the placement is read from its
  // source: each entry that starts new Container work asks the switch before that work starts.
  it.each([
    ['beginToolOperation', 'this.#toolOperations.begin('],
    ['beginSeed', 'this.withStatefulOperation('],
    ['installDependenciesTool', 'this.runToolOperation('],
    ['validateTool', 'this.runValidationTool('],
    ['beginDeploymentSession', 'this.#operationLane.acquire('],
  ])('%s asks the switch before it starts work', (method, work) => {
    const start = runtimeSource.indexOf(`  async ${method}(`);
    expect(start).toBeGreaterThan(0);
    const end = runtimeSource.indexOf('\n  }\n', start);
    const body = runtimeSource.slice(start, end);
    const admission = body.indexOf('await this.#admission.admitNewOperation();');
    expect(admission).toBeGreaterThan(0);
    expect(body.indexOf(work)).toBeGreaterThan(admission);
  });
});

function controlDatabase(control: { enabled: number; reason: string | null } | null) {
  const state = {
    control,
    reads: 0,
    binding: {} as D1Database,
  };
  state.binding = {
    prepare: (query: string) => {
      expect(query).toContain(`FROM runtime_controls WHERE key = 'computer_operations'`);
      return {
        first: async () => {
          state.reads += 1;
          return state.control;
        },
      };
    },
  } as unknown as D1Database;
  return state;
}
