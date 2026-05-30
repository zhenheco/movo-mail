/**
 * Data-access implementation for Movo Mail (D1).
 *
 * Every query uses parameterized D1 prepared statements (`?` placeholders +
 * `.bind(...)`) — never string interpolation of untrusted values — so user
 * input can never be interpreted as SQL. All public functions wrap their D1
 * calls in try/catch and surface a friendly error. Returned rows are fresh
 * objects and the caller's input objects are never mutated (immutable inputs).
 *
 * The contract types live here too so callers can `import { OutboundMessageInput
 * } from "../db"` without reaching into a sibling file.
 */

import { v4 as uuid } from "uuid";
import type {
  Env,
  Thread,
  Message,
  Attachment,
  SendLogRow,
  AuditRow,
  Mailbox,
  ParsedInbound,
  SendStatus,
} from "../types";

/** A message together with its attachments (for the thread/message views). */
export interface MessageWithAttachments extends Message {
  attachments: Attachment[];
}

/** A thread together with its ordered messages (oldest → newest). */
export interface ThreadWithMessages extends Thread {
  messages: MessageWithAttachments[];
}

/** Fields required to persist an outbound message copy. */
export interface OutboundMessageInput {
  /**
   * Existing thread to attach to (a reply). Omit for a brand-new conversation:
   * insertOutboundMessage will create a thread row so the message never points
   * at a phantom thread (which would violate the messages→threads FK).
   */
  threadId?: string;
  mailboxId: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  snippet: string | null;
  hasAttachments: boolean;
  date: number;
}

/** Fields used to find-or-create the thread for a message. */
export interface UpsertThreadInput {
  mailboxId: string;
  /** Existing thread id if known (e.g. via In-Reply-To/References lookup). */
  threadId?: string;
  subject: string | null;
  snippet: string | null;
  lastMessageAt: number;
  /** Whether the latest message is unread (inbound). */
  unread: boolean;
}

/** Fields used to write a send-log row. */
export interface SendLogInput {
  messageId: string | null;
  idempotencyKey: string;
  providerId: string | null;
  status: SendStatus;
  toAddresses: string[];
  subject: string | null;
  error: string | null;
}

/** Fields used to write an audit-log row. */
export interface AuditInput {
  userId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Booleans are stored as SQLite 0/1 integers. */
const bool = (b: boolean): number => (b ? 1 : 0);

/** Escape LIKE wildcards so a user query is matched literally. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Wrap a D1 operation so failures surface as a single, friendly Error rather
 * than leaking driver internals. The original cause is preserved for logs.
 */
async function guard<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Database operation failed (${op}): ${detail}`, { cause });
  }
}

/** Column list shared by message reads (kept identical across queries). */
const MESSAGE_COLS = `id, thread_id, mailbox_id, message_id, in_reply_to,
        "references", direction, from_address, from_name, to_addresses,
        cc_addresses, bcc_addresses, subject, snippet, text_body, html_body,
        r2_raw_key, has_attachments, unread, date, created_at`;

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/** List threads in a mailbox, newest activity first. */
export async function getThreads(
  env: Env,
  mailboxId: string,
): Promise<Thread[]> {
  return guard("getThreads", async () => {
    const { results } = await env.DB.prepare(
      `SELECT id, mailbox_id, subject, snippet, last_message_at, message_count,
              unread, created_at, updated_at
         FROM threads
        WHERE mailbox_id = ?
        ORDER BY last_message_at DESC`,
    )
      .bind(mailboxId)
      .all<Thread>();
    return (results ?? []).map((r) => ({ ...r }));
  });
}

/** Load a single thread with all its messages + attachments. */
export async function getThread(
  env: Env,
  id: string,
): Promise<ThreadWithMessages | null> {
  return guard("getThread", async () => {
    const thread = await env.DB.prepare(
      `SELECT id, mailbox_id, subject, snippet, last_message_at, message_count,
              unread, created_at, updated_at
         FROM threads
        WHERE id = ?`,
    )
      .bind(id)
      .first<Thread>();
    if (!thread) {
      return null;
    }

    const { results: msgRows } = await env.DB.prepare(
      `SELECT ${MESSAGE_COLS}
         FROM messages
        WHERE thread_id = ?
        ORDER BY date ASC`,
    )
      .bind(id)
      .all<Message>();

    const messages = await Promise.all(
      (msgRows ?? []).map(async (m) => ({
        ...m,
        attachments: await loadAttachments(env, m.id),
      })),
    );

    return { ...thread, messages };
  });
}

/** Load a single message with its attachments. */
export async function getMessage(
  env: Env,
  id: string,
): Promise<MessageWithAttachments | null> {
  return guard("getMessage", async () => {
    const message = await env.DB.prepare(
      `SELECT ${MESSAGE_COLS} FROM messages WHERE id = ?`,
    )
      .bind(id)
      .first<Message>();
    if (!message) {
      return null;
    }
    return { ...message, attachments: await loadAttachments(env, id) };
  });
}

/** Internal: load attachment rows for a message. */
async function loadAttachments(
  env: Env,
  messageId: string,
): Promise<Attachment[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, message_id, filename, content_type, size_bytes, content_id,
            inline, r2_key, created_at
       FROM attachments
      WHERE message_id = ?
      ORDER BY created_at ASC, rowid ASC`,
  )
    .bind(messageId)
    .all<Attachment>();
  return (results ?? []).map((r) => ({ ...r }));
}

/** Full-text-ish search across messages, optionally scoped to a mailbox. */
export async function searchMessages(
  env: Env,
  q: string,
  mailboxId?: string,
): Promise<Message[]> {
  return guard("searchMessages", async () => {
    const like = `%${escapeLike(q)}%`;
    // One bound `?` per column tested. Positional placeholders keep the SQL
    // portable across D1 and any standard SQLite engine.
    const matchClause = `(subject LIKE ? ESCAPE '\\'
              OR text_body LIKE ? ESCAPE '\\'
              OR snippet LIKE ? ESCAPE '\\'
              OR from_address LIKE ? ESCAPE '\\')`;

    const stmt = mailboxId
      ? env.DB.prepare(
          `SELECT ${MESSAGE_COLS} FROM messages
            WHERE ${matchClause} AND mailbox_id = ?
            ORDER BY date DESC LIMIT 100`,
        ).bind(like, like, like, like, mailboxId)
      : env.DB.prepare(
          `SELECT ${MESSAGE_COLS} FROM messages
            WHERE ${matchClause}
            ORDER BY date DESC LIMIT 100`,
        ).bind(like, like, like, like);

    const { results } = await stmt.all<Message>();
    return (results ?? []).map((r) => ({ ...r }));
  });
}

/** Resolve a mailbox by its email address. */
export async function getMailboxByAddress(
  env: Env,
  addr: string,
): Promise<Mailbox | null> {
  return guard("getMailboxByAddress", async () => {
    const row = await env.DB.prepare(
      `SELECT id, address, display_name, owner_id, created_at, updated_at
         FROM mailboxes
        WHERE address = ?`,
    )
      .bind(addr)
      .first<Mailbox>();
    return row ? { ...row } : null;
  });
}

/**
 * List every mailbox the given user owns, resolved by the user's email.
 *
 * Used by the read API to scope all results to the authenticated user: a user
 * must never see data from a mailbox they do not own. Ownership is the
 * `mailboxes.owner_id -> users.id` link, matched against the verified Access
 * email. Returns [] when the user owns no mailboxes (or does not exist).
 */
export async function getMailboxesForUser(
  env: Env,
  userEmail: string,
): Promise<Mailbox[]> {
  return guard("getMailboxesForUser", async () => {
    const { results } = await env.DB.prepare(
      `SELECT m.id, m.address, m.display_name, m.owner_id, m.created_at,
              m.updated_at
         FROM mailboxes m
         JOIN users u ON u.id = m.owner_id
        WHERE u.email = ?
        ORDER BY m.address ASC`,
    )
      .bind(userEmail)
      .all<Mailbox>();
    return (results ?? []).map((r) => ({ ...r }));
  });
}

/** Read a send-log row by its local id (for status polling). */
export async function getSendLog(
  env: Env,
  id: string,
): Promise<SendLogRow | null> {
  return guard("getSendLog", async () => {
    const row = await env.DB.prepare(
      `SELECT id, message_id, idempotency_key, provider_id, status, to_addresses,
              subject, error, created_at, updated_at
         FROM send_log
        WHERE id = ?`,
    )
      .bind(id)
      .first<SendLogRow>();
    return row ? { ...row } : null;
  });
}

/** Read recent audit rows (for the audit view). */
export async function getAuditLog(env: Env, limit = 100): Promise<AuditRow[]> {
  return guard("getAuditLog", async () => {
    const { results } = await env.DB.prepare(
      `SELECT id, user_id, actor_email, action, target_type, target_id, detail,
              ip, created_at
         FROM audit_log
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    )
      .bind(limit)
      .all<AuditRow>();
    return (results ?? []).map((r) => ({ ...r }));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

/** Find-or-create the thread for a message. Returns the thread id. */
export async function upsertThread(
  env: Env,
  input: UpsertThreadInput,
): Promise<string> {
  return guard("upsertThread", async () => {
    const now = Date.now();

    if (input.threadId) {
      // Bump activity on an existing thread, OR-ing in unread.
      const updated = await env.DB.prepare(
        `UPDATE threads
            SET subject = COALESCE(?, subject),
                snippet = ?,
                last_message_at = ?,
                message_count = message_count + 1,
                unread = CASE WHEN ? = 1 THEN 1 ELSE unread END,
                updated_at = ?
          WHERE id = ?`,
      )
        .bind(
          input.subject,
          input.snippet,
          input.lastMessageAt,
          bool(input.unread),
          now,
          input.threadId,
        )
        .run();
      // If nothing was updated the thread id was stale — fall through to insert
      // (using the requested id so the caller's reference stays valid).
      if ((updated.meta?.changes ?? 0) > 0) {
        return input.threadId;
      }
    }

    const id = input.threadId ?? uuid();
    await env.DB.prepare(
      `INSERT INTO threads
         (id, mailbox_id, subject, snippet, last_message_at, message_count,
          unread, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
      .bind(
        id,
        input.mailboxId,
        input.subject,
        input.snippet,
        input.lastMessageAt,
        bool(input.unread),
        now,
        now,
      )
      .run();
    return id;
  });
}

/**
 * Persist a fully-parsed inbound message: resolves the destination mailbox,
 * upserts the thread (grouping a reply into the prior conversation via
 * In-Reply-To/References when possible), inserts the message row, and inserts
 * attachment index rows. Returns the message id.
 *
 * `messageId` is supplied by the caller (the inbound handler) so the SAME id is
 * used for the message PK, the `r2_raw_key`, and every attachment `r2_key` —
 * keeping the D1 row and the R2 objects the handler archived under that id in
 * lockstep. Defaults to a fresh uuid when omitted (e.g. in isolated tests).
 */
export async function insertInboundMessage(
  env: Env,
  parsed: ParsedInbound,
  messageId: string = uuid(),
): Promise<string> {
  return guard("insertInboundMessage", async () => {
    const mailbox = await getMailboxByAddress(env, parsed.mailboxAddress);
    if (!mailbox) {
      throw new Error(`unknown mailbox: ${parsed.mailboxAddress}`);
    }

    const existingThreadId = await findThreadIdForReply(
      env,
      mailbox.id,
      parsed.inReplyTo,
      parsed.references,
    );

    const threadId = await upsertThread(env, {
      mailboxId: mailbox.id,
      threadId: existingThreadId ?? undefined,
      subject: parsed.subject,
      snippet: parsed.snippet,
      lastMessageAt: parsed.date,
      unread: true,
    });

    const now = Date.now();
    const r2RawKey = `msg/${messageId}.eml`;
    const hasAttachments = parsed.attachments.length > 0;

    await env.DB.prepare(
      `INSERT INTO messages
         (id, thread_id, mailbox_id, message_id, in_reply_to, "references",
          direction, from_address, from_name, to_addresses, cc_addresses,
          bcc_addresses, subject, snippet, text_body, html_body, r2_raw_key,
          has_attachments, unread, date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        messageId,
        threadId,
        mailbox.id,
        parsed.messageId,
        parsed.inReplyTo,
        parsed.references.length > 0 ? parsed.references.join(" ") : null,
        parsed.from.address,
        parsed.from.name ?? null,
        JSON.stringify(parsed.to.map((a) => a.address)),
        parsed.cc.length > 0
          ? JSON.stringify(parsed.cc.map((a) => a.address))
          : null,
        parsed.bcc.length > 0
          ? JSON.stringify(parsed.bcc.map((a) => a.address))
          : null,
        parsed.subject,
        parsed.snippet,
        parsed.text,
        parsed.html,
        r2RawKey,
        bool(hasAttachments),
        parsed.date,
        now,
      )
      .run();

    await insertAttachments(env, messageId, parsed.attachments);
    return messageId;
  });
}

/** Internal: insert attachment index rows (bytes are stored in R2 by caller). */
async function insertAttachments(
  env: Env,
  messageId: string,
  attachments: ParsedInbound["attachments"],
): Promise<void> {
  let n = 0;
  for (const att of attachments) {
    const id = uuid();
    await env.DB.prepare(
      `INSERT INTO attachments
         (id, message_id, filename, content_type, size_bytes, content_id,
          inline, r2_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        messageId,
        att.filename,
        att.contentType,
        att.content.byteLength,
        att.contentId,
        bool(att.inline),
        `att/${messageId}/${n}`,
        Date.now(),
      )
      .run();
    n += 1;
  }
}

/**
 * Persist a stored copy of an outbound message. Returns the new message id.
 *
 * Always resolves a real parent thread first (upsertThread): for a reply it
 * reuses the given threadId, for a brand-new send it creates a fresh thread
 * row. This guarantees the messages→threads FK is satisfied, so the sent copy
 * is actually persisted and shows up in getThreads/getThread — never an
 * invisible message pointing at a phantom thread.
 */
export async function insertOutboundMessage(
  env: Env,
  msg: OutboundMessageInput,
): Promise<string> {
  return guard("insertOutboundMessage", async () => {
    const id = uuid();
    const now = Date.now();
    const r2RawKey = `msg/${id}.eml`;

    // Find-or-create the thread so the message always has a valid parent row.
    const threadId = await upsertThread(env, {
      mailboxId: msg.mailboxId,
      threadId: msg.threadId,
      subject: msg.subject,
      snippet: msg.snippet,
      lastMessageAt: msg.date,
      // Outbound mail is authored by the operator → not unread.
      unread: false,
    });

    await env.DB.prepare(
      `INSERT INTO messages
         (id, thread_id, mailbox_id, message_id, in_reply_to, "references",
          direction, from_address, from_name, to_addresses, cc_addresses,
          bcc_addresses, subject, snippet, text_body, html_body, r2_raw_key,
          has_attachments, unread, date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
      .bind(
        id,
        threadId,
        msg.mailboxId,
        msg.messageId,
        msg.inReplyTo,
        msg.references,
        msg.fromAddress,
        msg.fromName,
        JSON.stringify(msg.toAddresses),
        msg.ccAddresses.length > 0 ? JSON.stringify(msg.ccAddresses) : null,
        msg.bccAddresses.length > 0 ? JSON.stringify(msg.bccAddresses) : null,
        msg.subject,
        msg.snippet,
        msg.text,
        msg.html,
        r2RawKey,
        bool(msg.hasAttachments),
        msg.date,
        now,
      )
      .run();
    return id;
  });
}

/** Write a send-log row. Returns the new row id. */
export async function insertSendLog(
  env: Env,
  input: SendLogInput,
): Promise<string> {
  return guard("insertSendLog", async () => {
    const id = uuid();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO send_log
         (id, message_id, idempotency_key, provider_id, status, to_addresses,
          subject, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        input.messageId,
        input.idempotencyKey,
        input.providerId,
        input.status,
        JSON.stringify(input.toAddresses),
        input.subject,
        input.error,
        now,
        now,
      )
      .run();
    return id;
  });
}

/** Update a send-log row's status/provider id (after relay response). */
export async function updateSendLogStatus(
  env: Env,
  id: string,
  status: SendStatus,
  providerId: string | null,
  error: string | null,
): Promise<void> {
  await guard("updateSendLogStatus", async () => {
    await env.DB.prepare(
      `UPDATE send_log
          SET status = ?,
              provider_id = COALESCE(?, provider_id),
              error = ?,
              updated_at = ?
        WHERE id = ?`,
    )
      .bind(status, providerId, error, Date.now(), id)
      .run();
  });
}

/** Write an audit-log row. Returns the new row id. */
export async function insertAudit(
  env: Env,
  input: AuditInput,
): Promise<string> {
  return guard("insertAudit", async () => {
    const id = uuid();
    await env.DB.prepare(
      `INSERT INTO audit_log
         (id, user_id, actor_email, action, target_type, target_id, detail, ip,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        input.userId,
        input.actorEmail,
        input.action,
        input.targetType,
        input.targetId,
        input.detail ? JSON.stringify(input.detail) : null,
        input.ip,
        Date.now(),
      )
      .run();
    return id;
  });
}

/**
 * Internal: find an existing thread to group a reply into, using the
 * In-Reply-To / References Message-IDs to locate a prior message in the same
 * mailbox. Returns the thread id, or null when this is a new conversation.
 */
async function findThreadIdForReply(
  env: Env,
  mailboxId: string,
  inReplyTo: string | null,
  references: string[],
): Promise<string | null> {
  const candidates = [...(inReplyTo ? [inReplyTo] : []), ...references].filter(
    (v, i, arr) => arr.indexOf(v) === i,
  );
  if (candidates.length === 0) {
    return null;
  }

  // Parameterized IN-list (one ? per candidate) + mailbox scope.
  const placeholders = candidates.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    `SELECT thread_id FROM messages
      WHERE mailbox_id = ? AND message_id IN (${placeholders})
      ORDER BY date DESC LIMIT 1`,
  )
    .bind(mailboxId, ...candidates)
    .first<{ thread_id: string }>();
  return row?.thread_id ?? null;
}
