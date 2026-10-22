-- Whether a connection may bill Workers AI is whether its granted capabilities include workers_ai, which
-- is all this column ever recorded beside them. Nothing reads or writes it any more.
ALTER TABLE cloudflare_connections DROP COLUMN ai_billing_enabled;
