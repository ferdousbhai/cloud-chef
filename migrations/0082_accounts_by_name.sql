-- A person's own place to build was named "<first name>’s space" when it was made. Nobody reads the word any more:
-- the people added to its projects are told whose account it is.
UPDATE organizations
SET name = substr(name, 1, length(name) - length('space')) || 'account'
WHERE personal_user_id IS NOT NULL AND (name LIKE '%’s space' OR name = 'My space');
