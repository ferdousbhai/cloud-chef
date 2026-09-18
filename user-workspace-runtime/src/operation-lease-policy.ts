import type { ModelToolName } from 'cloudchef-agent/model-tool-inputs';
import { BUILDER_TURN_TIMEOUTS } from '../../app/lib/.server/llm/builder-turn-budget';

/**
 * How long a lane stays held with no further proof that its owner is alive.
 *
 * This is a reclaim window, not a work ceiling. It exists so a request whose
 * owner died cannot hold the workspace forever; an owner that keeps proving
 * itself alive renews it for as long as the work legitimately runs.
 */
export const OPERATION_LEASE_MS = {
  seed: 10 * 60_000,
  write: 10 * 60_000,
  exec: 10 * 60_000,
  install: 15 * 60_000,
  validate: 30 * 60_000,
  deployment: 45 * 60_000,
  delete: 15 * 60_000,
} as const;

export type StatefulOperationKind = keyof typeof OPERATION_LEASE_MS;

/**
 * The model tools that can occupy each lane. A lane is reachable from more than
 * one tool because the exec tool dispatches full-validation and dependency
 * commands to their own lanes, and because write and edit share one write lane.
 */
export const OPERATION_LANE_TOOLS = {
  write: ['write', 'edit'],
  exec: ['exec'],
  install: ['exec'],
  validate: ['exec', 'validate'],
} as const satisfies Partial<Record<StatefulOperationKind, readonly ModelToolName[]>>;

type ToolGovernedOperationKind = keyof typeof OPERATION_LANE_TOOLS;

/**
 * The longest a model tool may keep each lane occupied. Derived from the tool
 * budgets rather than restated, so the lane below a tool and the tool above it
 * cannot declare different ceilings for the same piece of work.
 */
export const OPERATION_TOOL_BUDGET_MS = {
  write: longestToolBudget(OPERATION_LANE_TOOLS.write),
  exec: longestToolBudget(OPERATION_LANE_TOOLS.exec),
  install: longestToolBudget(OPERATION_LANE_TOOLS.install),
  validate: longestToolBudget(OPERATION_LANE_TOOLS.validate),
} satisfies Record<ToolGovernedOperationKind, number>;

function longestToolBudget(tools: readonly ModelToolName[]): number {
  return Math.max(...tools.map((tool) => BUILDER_TURN_TIMEOUTS.tools[tool]));
}

/**
 * Ceiling for one network package installation in the workspace container.
 *
 * Declared once and shared by everything that is this class of work: the
 * project dependency installations and the container toolchain bootstrap that
 * installs the pinned pnpm before any of them can run (#131). It must stay
 * inside the install lane's tool budget, so the container cannot kill an
 * installation the tool layer still allows — the #127 guard shape, pinned by
 * test.
 */
export const CONTAINER_PACKAGE_INSTALL_TIMEOUT_MS = 10 * 60_000;

function isToolGovernedOperation(kind: StatefulOperationKind): kind is ToolGovernedOperationKind {
  return Object.hasOwn(OPERATION_LANE_TOOLS, kind);
}

type OperationLeasePlan = {
  /** Reclaim window applied at acquisition and at every renewal. */
  leaseMs: number;
  /**
   * How long after acquisition silence alone still counts as proof of life, or
   * null for a lane nobody renews, whose lease is therefore its whole ceiling.
   *
   * A healthy `tsc` prints nothing for minutes, so treating silence as death is
   * what killed real builds. Past this horizon the tool above the lane has run
   * out of budget anyway, and only observed progress can still keep the lane.
   */
  silenceHorizonMs: number | null;
};

export function operationLeasePlan(kind: StatefulOperationKind): OperationLeasePlan {
  return {
    leaseMs: OPERATION_LEASE_MS[kind],
    silenceHorizonMs: isToolGovernedOperation(kind) ? OPERATION_TOOL_BUDGET_MS[kind] : null,
  };
}
