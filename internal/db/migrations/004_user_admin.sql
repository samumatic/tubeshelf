-- A paused account cannot sign in; its data stays.
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
-- Set by an admin with a temporary password: the user picks their own at the next sign-in.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
-- How the account came to be: '' (an admin), 'setup', 'register' or 'oidc'.
ALTER TABLE users ADD COLUMN source TEXT NOT NULL DEFAULT '';
