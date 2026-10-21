-- The upgrade that claimed the window, named by its Workflow instance. Another upgrade cannot claim,
-- renew or release a window one still holds open. A window claimed before this column existed has no
-- holder, and any upgrade may renew or release it, as before.
ALTER TABLE runtime_upgrade_window ADD COLUMN holder TEXT;
