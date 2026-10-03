import { describe, expect, it } from 'vitest';
import { WORKSPACE_READ_ONLY_TOOL_NAMES } from '../../cloudchef-agent/model-tool-inputs';
import { BUILDER_TURN_TIMEOUTS } from '../../app/lib/.server/llm/builder-turn-budget';
import {
  CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS,
  OPERATION_LANE_TOOLS,
  OPERATION_LEASE_MS,
  OPERATION_TOOL_BUDGET_MS,
  operationLeasePlan,
  type StatefulOperationKind,
} from './operation-lease-policy';

const kinds = Object.keys(OPERATION_LEASE_MS) as StatefulOperationKind[];

describe('operation lease policy', () => {
  it('never lets a lane lease and the tool budget above it declare different ceilings', () => {
    for (const [kind, tools] of Object.entries(OPERATION_LANE_TOOLS)) {
      const budget = Math.max(...tools.map((tool) => BUILDER_TURN_TIMEOUTS.tools[tool]));
      const plan = operationLeasePlan(kind as StatefulOperationKind);

      // The defect this guard exists for: a lease shorter than the budget above
      // it, with nothing renewing the lane, truncates work the tool layer allows.
      expect(plan.leaseMs >= budget || plan.silenceHorizonMs !== null).toBe(true);
      expect(plan.silenceHorizonMs).toBe(budget);
      expect(OPERATION_TOOL_BUDGET_MS[kind as keyof typeof OPERATION_TOOL_BUDGET_MS]).toBe(budget);
    }
  });

  it('maps every model tool that can hold the workspace to a lane', () => {
    const governed = new Set(Object.values(OPERATION_LANE_TOOLS).flat());

    // The VFS-only workspace tools and the remote docs search never take a lane; everything else
    // must. A discovery tool that slipped into a lane would wait on the container it exists to
    // avoid.
    expect(Object.keys(BUILDER_TURN_TIMEOUTS.tools).filter((tool) => !governed.has(tool as never))).toEqual([
      ...WORKSPACE_READ_ONLY_TOOL_NAMES,
      'search_cloudflare_docs',
      // cloudflare_request is sent by the runtime Worker directly and must never take a
      // workspace lane, so it belongs with the other ungoverned tools.
      'cloudflare_request',
    ]);
  });

  it('governs the write lane by the longer of the two tools that share it', () => {
    expect(OPERATION_LANE_TOOLS.write).toEqual(['write', 'edit']);
    expect(OPERATION_TOOL_BUDGET_MS.write).toBe(
      Math.max(BUILDER_TURN_TIMEOUTS.tools.write, BUILDER_TURN_TIMEOUTS.tools.edit),
    );
  });

  it('leaves lanes no model tool can occupy on their lease alone', () => {
    for (const kind of kinds) {
      if (kind in OPERATION_LANE_TOOLS) {
        continue;
      }
      expect(operationLeasePlan(kind)).toEqual({ leaseMs: OPERATION_LEASE_MS[kind], silenceHorizonMs: null });
    }
  });

  it('keeps the package-install ceiling inside the budget of the tools it serves', () => {
    // The container may not kill an installation the tool layer still allows —
    // the same guard as the lease derivation, extended to the container-side
    // ceiling the toolchain bootstrap shares (#131).
    expect(CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS).toBeLessThanOrEqual(OPERATION_TOOL_BUDGET_MS.install);
    expect(CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS).toBeLessThanOrEqual(OPERATION_TOOL_BUDGET_MS.exec);
  });

  it('renews exactly the lanes whose lease is shorter than their governing budget', () => {
    for (const kind of kinds) {
      const plan = operationLeasePlan(kind);
      if (plan.silenceHorizonMs === null) {
        continue;
      }
      expect(plan.leaseMs).toBeLessThanOrEqual(plan.silenceHorizonMs);
    }
  });
});
