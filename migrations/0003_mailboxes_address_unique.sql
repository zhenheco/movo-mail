-- Movo Mail — enforce a UNIQUE mailbox address index (0003)
--
-- Defense-in-depth for the inbound-mail hijack risk: a second mailbox row for an
-- already-managed address (pointed at a different owner_id) would grant that
-- owner visibility of another address's inbound mail (getMailboxesForUser JOINs
-- on owner_id). createMailbox already does an existence check + 409, but a
-- UNIQUE index makes a duplicate physically impossible even under a race.
--
-- Addresses are stored already-lowercased (see normalizeAddress in src/db), so a
-- plain UNIQUE index is effectively case-insensitive: `Sales@` and `sales@` fold
-- to the same stored value and cannot coexist.
--
-- The 0001 schema already declares `address TEXT NOT NULL UNIQUE` on the column
-- AND a non-unique idx_mailboxes_address. We replace the non-unique helper index
-- with a UNIQUE one so the intent is explicit and enforced at the index layer too.

DROP INDEX IF EXISTS idx_mailboxes_address;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mailboxes_address ON mailboxes (address);
