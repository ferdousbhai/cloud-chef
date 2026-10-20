-- Whether a person's model requests are logged with their content (prompts, conversation context,
-- project files sent, and model replies) in the connected Cloudflare account's AI Gateway. On unless
-- they turn it off in Settings; off, their requests still go through the gateway, unlogged.
ALTER TABLE "user" ADD COLUMN ai_gateway_content_logging INTEGER NOT NULL DEFAULT 1
  CHECK (ai_gateway_content_logging IN (0, 1));
