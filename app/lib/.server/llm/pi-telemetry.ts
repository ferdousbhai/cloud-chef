import type { BuilderTurnReport } from './builder-turn-limits';

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

export function recordPiTurnReport(modelId: string, report: BuilderTurnReport): void {
  console.info({ event: 'cloudchef_pi_turn_budget', modelId, ...report });
}
