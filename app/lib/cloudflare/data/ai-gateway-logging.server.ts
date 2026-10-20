/**
 * A person's choice whether their model requests are logged with their content (prompts, conversation
 * context, project files sent, model replies) in the connected Cloudflare account's AI Gateway. On
 * unless they turn it off. Only the person decides: a team's admins can't turn it back on for them.
 */
export async function readAiGatewayContentLogging(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT ai_gateway_content_logging AS logging FROM "user" WHERE id = ?')
    .bind(userId)
    .first<{ logging: number }>();
  // No such person: nothing to log for, so nothing is logged.
  return row?.logging === 1;
}

export async function setAiGatewayContentLogging(db: D1Database, userId: string, enabled: boolean): Promise<void> {
  await db
    .prepare('UPDATE "user" SET ai_gateway_content_logging = ? WHERE id = ?')
    .bind(enabled ? 1 : 0, userId)
    .run();
}
