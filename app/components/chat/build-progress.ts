import { isStreamStatusActive, type StreamStatus } from '~/lib/common/types';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';

type BuildProgressPhase = 'planning' | 'thinking' | 'creating' | 'saving' | 'running' | 'validating' | 'recovering';

export type BuildProgress = {
  phase: BuildProgressPhase;
  message: string;
  delayed: boolean;
};

const BUILD_PROGRESS_DELAY_MS = 45_000;
// Validation is one bounded Computer operation, so these windows cover the full pipeline.
const VALIDATION_PROGRESS_DELAY_MS = 2 * 60_000;
const RECOVERY_PROGRESS_DELAY_MS = 5 * 60_000;

export function getBuildProgress(args: {
  streamStatus: StreamStatus;
  isRecovering: boolean;
  isProjectUpdate?: boolean;
  activeToolNames: string[];
  validationStage?: BuilderValidationStage | null;
  /** Milliseconds the model has been reasoning in the part it is streaming now, if it is. */
  reasoningForMs?: number | null;
  inactiveForMs: number;
}): BuildProgress | null {
  if (!isStreamStatusActive(args.streamStatus)) {
    return null;
  }

  const phase = buildPhase(args);
  const delayMs =
    phase === 'validating'
      ? VALIDATION_PROGRESS_DELAY_MS
      : phase === 'recovering'
        ? RECOVERY_PROGRESS_DELAY_MS
        : BUILD_PROGRESS_DELAY_MS;
  const delayed = args.inactiveForMs >= delayMs;
  const normalMessage = phaseMessage(
    phase,
    args.isProjectUpdate === true,
    args.validationStage,
    args.reasoningForMs ?? null,
  );
  const activity = activityLabel(phase, args.isProjectUpdate === true, args.validationStage);

  return {
    phase,
    delayed,
    message: delayed ? quietMessage(phase, activity, args.inactiveForMs) : normalMessage,
  };
}

function buildPhase(args: {
  streamStatus: StreamStatus;
  isRecovering: boolean;
  activeToolNames: string[];
  validationStage?: BuilderValidationStage | null;
  reasoningForMs?: number | null;
}): BuildProgressPhase {
  if (args.validationStage) {
    return 'validating';
  }
  if (args.activeToolNames.includes('exec')) {
    return 'running';
  }
  if (args.activeToolNames.some((name) => name === 'write' || name === 'edit')) {
    return 'saving';
  }
  if (args.isRecovering) {
    return 'recovering';
  }
  // Reasoning is real work with no tool behind it, so name it rather than calling the wait planning.
  if (args.reasoningForMs !== null && args.reasoningForMs !== undefined) {
    return 'thinking';
  }
  return args.streamStatus === 'submitted' ? 'planning' : 'creating';
}

function phaseMessage(
  phase: BuildProgressPhase,
  isProjectUpdate: boolean,
  validationStage?: BuilderValidationStage | null,
  reasoningForMs?: number | null,
): string {
  switch (phase) {
    case 'planning':
      return isProjectUpdate ? 'Planning your changes…' : 'Planning your project…';
    case 'thinking':
      return reasoningForMs !== null && reasoningForMs !== undefined && reasoningForMs >= 1_000
        ? `Thinking… ${formatDuration(reasoningForMs)}`
        : 'Thinking…';
    case 'creating':
      return isProjectUpdate ? 'Updating your project…' : 'Creating your project…';
    case 'saving':
      return 'Saving changes…';
    case 'running':
      return 'Running command…';
    case 'validating':
      return validationStageMessage(validationStage);
    case 'recovering':
      return 'Recovering the interrupted build…';
  }
  return 'Building your project…';
}

function activityLabel(
  phase: BuildProgressPhase,
  isProjectUpdate: boolean,
  validationStage?: BuilderValidationStage | null,
): string {
  switch (phase) {
    case 'planning':
      return isProjectUpdate ? 'planning your changes' : 'planning your project';
    case 'thinking':
      return 'thinking';
    case 'creating':
      return isProjectUpdate ? 'updating your project' : 'creating your project';
    case 'saving':
      return 'saving changes';
    case 'running':
      return 'running the command';
    case 'validating':
      return validationStageActivity(validationStage);
    case 'recovering':
      return 'recovering the build';
  }
  return 'building your project';
}

/** Each message names the step the workspace runtime reported entering, not a guess from a clock. */
function validationStageMessage(stage?: BuilderValidationStage | null): string {
  switch (stage) {
    case 'computer validation':
      return 'Validating your project with Cloudflare Computer…';
    case 'preparing':
      return 'Preparing a clean copy of your project…';
    case 'installing':
      return 'Installing dependencies…';
    case 'typecheck':
      return 'Checking types…';
    case 'lint':
      return 'Linting and verifying the stack…';
    case 'build':
      return 'Building your project…';
    case 'packaging':
      return 'Packaging the Cloudflare Worker…';
    case 'finalizing':
      return 'Finishing validation…';
  }
  return 'Validating your project…';
}

function validationStageActivity(stage?: BuilderValidationStage | null): string {
  return validationStageMessage(stage).replace(/…$/, '').toLowerCase();
}

function quietMessage(phase: BuildProgressPhase, activity: string, inactiveForMs: number): string {
  const quietFor = formatDuration(inactiveForMs);
  if (phase === 'running') {
    return `Command is still running — no new output for ${quietFor}`;
  }
  return `Still ${activity} — no new update for ${quietFor}`;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.floor(milliseconds / 1_000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}
