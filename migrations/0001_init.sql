-- Movo Mail — initial D1 schema (0001_init)
-- Tables: users, mailboxes, threads, messages, attachments, send_log, audit_log
-- All timestamps are stored as INTEGER Unix epoch milliseconds (UTC).

PRAGMA foreign_keys = ON;

-- ─── users ───────────────────────────────────────────────────────────────────
-- People authenticated via Cloudflare Access (identity comes from the Access JWT).
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,            -- uuid
  email       TEXT NOT NULL UNIQUE,        -- Access identity email
  name        TEXT,                        -- display name (optional)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- ─── mailboxes ───────────────────────────────────────────────────────────────
-- An addressable inbox (e.g. support@movo.com.my). May be shared by users.
CREATE TABLE IF NOT EXISTS mailboxes (
  id          TEXT PRIMARY KEY,            -- uuid
  address     TEXT NOT NULL UNIQUE,        -- canonical email address
  display_name TEXT,                       -- friendly name shown in UI
  owner_id    TEXT,                        -- optional primary owner -> users.id
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_mailboxes_address ON mailboxes (address);
CREATE INDEX IF NOT EXISTS idx_mailboxes_owner ON mailboxes (owner_id);

-- ─── threads ─────────────────────────────────────────────────────────────────
-- A conversation grouping messages (by References/In-Reply-To or subject).
CREATE TABLE IF NOT EXISTS threads (
  id              TEXT PRIMARY KEY,        -- uuid
  mailbox_id      TEXT NOT NULL,           -- -> mailboxes.id
  subject         TEXT,                    -- normalized subject
  snippet         TEXT,                    -- short preview of latest message
  last_message_at INTEGER NOT NULL,        -- epoch ms of newest message
  message_count   INTEGER NOT NULL DEFAULT 0,
  unread          INTEGER NOT NULL DEFAULT 0, -- 0/1 boolean: has unread messages
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_threads_mailbox ON threads (mailbox_id);
CREATE INDEX IF NOT EXISTS idx_threads_last_message_at ON threads (mailbox_id, last_message_at DESC);

-- ─── messages ────────────────────────────────────────────────────────────────
-- A single email (inbound or outbound). Raw .eml lives in R2 at r2_raw_key.
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,          -- uuid
  thread_id     TEXT NOT NULL,             -- -> threads.id
  mailbox_id    TEXT NOT NULL,             -- -> mailboxes.id (denormalized for queries)
  message_id    TEXT,                      -- RFC 5322 Message-ID header
  in_reply_to   TEXT,                      -- In-Reply-To header
  "references"  TEXT,                      -- References header (space-joined); quoted: reserved word (D1 rejects bare)
  direction     TEXT NOT NULL,             -- 'inbound' | 'outbound'
  from_address  TEXT NOT NULL,
  from_name     TEXT,
  to_addresses  TEXT NOT NULL,             -- JSON array of strings
  cc_addresses  TEXT,                      -- JSON array of strings
  bcc_addresses TEXT,                      -- JSON array of strings
  subject       TEXT,
  snippet       TEXT,                      -- plaintext preview
  text_body     TEXT,                      -- plaintext body
  html_body     TEXT,                      -- sanitized HTML body
  r2_raw_key    TEXT,                      -- R2 object key for the raw .eml
  has_attachments INTEGER NOT NULL DEFAULT 0, -- 0/1 boolean
  unread        INTEGER NOT NULL DEFAULT 1,   -- 0/1 boolean
  date          INTEGER NOT NULL,          -- epoch ms (Date header or received time)
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads (id) ON DELETE CASCADE,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, date ASC);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages (mailbox_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages (message_id);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages (date DESC);

-- ─── attachments ─────────────────────────────────────────────────────────────
-- File attachments; bytes live in R2 at r2_key.
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,            -- uuid
  message_id  TEXT NOT NULL,               -- -> messages.id (FK by row id, not header)
  filename    TEXT NOT NULL,
  content_type TEXT,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  content_id  TEXT,                        -- Content-ID for inline (cid:) refs
  inline      INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
  r2_key      TEXT NOT NULL,               -- R2 object key for the bytes
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments (message_id);

-- ─── send_log ────────────────────────────────────────────────────────────────
-- Audit/idempotency record for every outbound send via the cf-email relay.
CREATE TABLE IF NOT EXISTS send_log (
  id               TEXT PRIMARY KEY,       -- uuid (local)
  message_id       TEXT,                   -- -> messages.id (the stored outbound copy)
  idempotency_key  TEXT NOT NULL UNIQUE,   -- key sent to cf-email relay
  provider_id      TEXT,                   -- id returned by cf-email relay
  status           TEXT NOT NULL,          -- 'queued' | 'sent' | 'failed'
  to_addresses     TEXT NOT NULL,          -- JSON array of strings
  subject          TEXT,
  error            TEXT,                   -- last error message if failed
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_send_log_message ON send_log (message_id);
CREATE INDEX IF NOT EXISTS idx_send_log_provider ON send_log (provider_id);
CREATE INDEX IF NOT EXISTS idx_send_log_status ON send_log (status);

-- ─── audit_log ───────────────────────────────────────────────────────────────
-- Generic security/action audit trail (who did what, when).
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,            -- uuid
  user_id     TEXT,                        -- -> users.id (nullable for system events)
  actor_email TEXT,                        -- denormalized actor email
  action      TEXT NOT NULL,               -- e.g. 'send', 'read', 'delete', 'login'
  target_type TEXT,                        -- e.g. 'message', 'thread', 'mailbox'
  target_id   TEXT,                        -- id of the affected entity
  detail      TEXT,                        -- JSON blob of extra context
  ip          TEXT,                        -- request IP (CF-Connecting-IP)
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log (created_at DESC);
