-- Durable local claim for one logical outbound relay operation.
-- A mailbox-scoped idempotency key can never be reused for a different payload.
CREATE TABLE IF NOT EXISTS send_attempts (
  id               TEXT PRIMARY KEY,
  mailbox_id       TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  canonical_hash   TEXT NOT NULL,
  provider_id      TEXT,
  message_id       TEXT,
  status           TEXT NOT NULL,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes (id) ON DELETE CASCADE,
  UNIQUE (mailbox_id, idempotency_key),
  UNIQUE (mailbox_id, idempotency_key, canonical_hash),
  CHECK (status IN ('queued', 'pending', 'sent', 'failed', 'sent_unarchived'))
);

CREATE INDEX IF NOT EXISTS idx_send_attempts_mailbox_key
  ON send_attempts (mailbox_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_send_attempts_provider
  ON send_attempts (provider_id);
