import type { WorkersAiAccountCredentials } from '~/lib/.server/llm/pi-ai-models';

export async function getUserWorkersAiCredentials(env: Env, userId: string): Promise<WorkersAiAccountCredentials> {
  if (!userId) {
    throw new Error('Cloudflare authentication is required.');
  }
  // SAFETY: the Workers AI binding exists only inside the generated user-owned runtime bundle, which
  // `app/user-runtime-env.d.ts` does not declare; the guard below refuses every other environment.
  const runtime = env as Env & { AI?: Ai };
  if (runtime.CLOUDCHEF_USER_RUNTIME !== '1' || !runtime.AI) {
    throw new Error('Workers AI must run through the user-owned Cloudflare runtime binding.');
  }
  return { binding: runtime.AI };
}
