-- The models a Cloudflare account's model picker offers, chosen by its admin (a team's admins, or the
-- person whose own account it is), as a JSON array of model ids. NULL means every compatible model,
-- including ones added later; once a list is saved, a model not on it is neither offered nor run. The
-- account's default model is always on it. Kept on the connection beside the default model, and read
-- by its workspace runtimes.
ALTER TABLE cloudflare_connections ADD COLUMN allowed_builder_models_json TEXT;
