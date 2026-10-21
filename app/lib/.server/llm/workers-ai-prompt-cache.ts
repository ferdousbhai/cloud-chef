import type { TranscriptIdentity } from 'cloudchef-agent/transcript';
import type { BuilderModelId } from '~/lib/workers-ai-model';
import { sha256Hex } from '~/lib/hex-digest';

export async function createWorkersAiSessionAffinity(
  identity: TranscriptIdentity,
  modelId: BuilderModelId,
): Promise<string> {
  return `gb-${await sha256Hex(
    JSON.stringify({
      agentName: identity.agentName,
      subchatIndex: identity.subchatIndex,
      generation: identity.generation,
      modelId,
    }),
  )}`;
}
