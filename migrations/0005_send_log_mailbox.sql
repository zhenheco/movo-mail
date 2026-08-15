ALTER TABLE send_log ADD COLUMN mailbox_id TEXT REFERENCES mailboxes (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_send_log_mailbox ON send_log (mailbox_id);
