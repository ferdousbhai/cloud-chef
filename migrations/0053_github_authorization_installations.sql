-- A return from GitHub's "Configure" for an account that already has CloudChef's GitHub App carries no proof of who
-- controls it, so CloudChef sends the person through GitHub's user authorization first. The state it starts that
-- with keeps the installation the return named, which the authorization's own return doesn't carry.
ALTER TABLE github_install_states ADD COLUMN installation_id INTEGER;
