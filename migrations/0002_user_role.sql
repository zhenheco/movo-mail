-- Movo Mail — add role to users (0002_user_role)
-- Adds a coarse authorization role so an admin can manage mailboxes from the UI.
-- D1 migrations run exactly once; this is a single idempotent-friendly ALTER.
-- Values: 'admin' (can manage mailboxes) | 'user' (default).

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';

-- Speeds up role lookups by email (getUserRole / admin gate on every request).
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
