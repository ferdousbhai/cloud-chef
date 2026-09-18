import type { BuilderTurnBudgetReport } from './builder-turn-budget';

type PiStageLogEntry = { event: string; stage: string; modelId: string; status?: number };

export function recordPiStage(stage: string, modelId: string, status?: number): void {
  const entry: PiStageLogEntry = {
    event: 'cloudchef_pi_stage',
    stage,
    modelId,
  };
  if (status !== undefined) {
    entry.status = status;
  }
  console.info(entry);
}

export function recordPiTurnBudget(modelId: string, budget: BuilderTurnBudgetReport): void {
  console.info({ event: 'cloudchef_pi_turn_budget', modelId, ...budget });
}
