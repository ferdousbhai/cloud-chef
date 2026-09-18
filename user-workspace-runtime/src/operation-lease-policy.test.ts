import { readFileSync } from 'node:fs';
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
      // The official Cloudflare MCP tools reach the provider directly and must never take a
      // workspace lane, so they belong with the other ungoverned tools.
      'cloudflare_docs',
      'cloudflare_search',
      'cloudflare_execute',
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

  it('declares every lane the ProjectWorkspace actually opens', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const opened = new Set(
      [...source.matchAll(/withStatefulOperation\(\s*'([a-z]+)'/g)].map((match) => match[1] as StatefulOperationKind),
    );

    expect([...opened].filter((kind) => !kinds.includes(kind))).toEqual([]);
    expect(kinds.filter((kind) => !opened.has(kind) && kind !== 'deployment')).toEqual([]);
  });

  it('keeps the package-install ceiling inside the budget of the tools it serves', () => {
    // The container may not kill an installation the tool layer still allows —
    // the same guard as the lease derivation, extended to the container-side
    // ceiling the toolchain bootstrap shares (#131).
    expect(CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS).toBeLessThanOrEqual(OPERATION_TOOL_BUDGET_MS.install);
    expect(CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS).toBeLessThanOrEqual(OPERATION_TOOL_BUDGET_MS.exec);
  });

  it('derives every container exec ceiling the ProjectWorkspace declares instead of restating it', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const sandboxAdapter = readFileSync(new URL('./computer-sandbox.ts', import.meta.url), 'utf8');

    // The exec tool's container-shell timeoutMs is a lifetime hint computerd
    // 0.1.1 does not enforce (#128); it is derived from the exec tool budget
    // so an enforcing computerd could never disagree with the layer above.
    expect(source).toContain('const EXEC_COMMAND_TIMEOUT_MS = OPERATION_TOOL_BUDGET_MS.exec;');
    expect(source.match(/timeoutMs: EXEC_COMMAND_TIMEOUT_MS/g)).toHaveLength(2);

    // The dependency-install ceiling and the toolchain bootstrap share one
    // declaration, and the vendor connect deadline is derived from the stages
    // it must contain rather than declared beside them (#131).
    expect(source).toContain('const INSTALL_TIMEOUT_MS = CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS;');
    expect(sandboxAdapter).toContain('connectTimeoutMs: CONTAINER_CONNECT_TIMEOUT_MS');
    expect(sandboxAdapter).not.toMatch(/connectTimeoutMs:\s*\d/);
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
