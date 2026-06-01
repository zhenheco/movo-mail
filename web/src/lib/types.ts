/**
 * UI-facing type mirrors of the server domain types.
 *
 * These intentionally re-declare only the fields the webmail UI consumes from
 * the API responses (a subset of src/types.ts). Keeping a local copy avoids
 * importing Worker-only types (which pull in @cloudflare/workers-types) into the
 * browser bundle, while staying byte-compatible with the JSON the API returns.
 */

/** Unix epoch milliseconds (UTC). */
export type EpochMs = number;

/** Message direction relative to the mailbox. */
export type Direction = "inbound" | "outbound";

/** A parsed email address with optional display name. */
export interface EmailAddress {
  address: string;
  name?: string;
}

/** A conversation thread, as returned by GET /api/threads. */
export interface Thread {
  id: string;
  mailbox_id: string;
  subject: string | null;
  snippet: string | null;
  last_message_at: EpochMs;
  /**
   * Id of this thread's latest message — the id ThreadView loads when the row is
   * opened. A thread id is a different uuid from any message id, so this (not
   * `id`) is what GET /api/message/:id must receive. Null for an empty thread.
   */
  last_message_id: string | null;
  message_count: number;
  /** 0/1 boolean as stored in SQLite. */
  unread: number;
  created_at: EpochMs;
  updated_at: EpochMs;
}

/** A single message row, as returned by GET /api/message/:id and /api/search. */
export interface Message {
  id: string;
  thread_id: string;
  mailbox_id: string;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  direction: Direction;
  from_address: string;
  from_name: string | null;
  /** JSON-encoded string[] as stored; parse on read. */
  to_addresses: string;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  subject: string | null;
  snippet: string | null;
  text_body: string | null;
  /** Raw parsed HTML body; MessageBody sanitizes it client-side before render. */
  html_body: string | null;
  r2_raw_key: string | null;
  has_attachments: number;
  unread: number;
  date: EpochMs;
  created_at: EpochMs;
}

/** An attachment row attached to a message. */
export interface Attachment {
  id: string;
  message_id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  content_id: string | null;
  inline: number;
  r2_key: string;
  created_at: EpochMs;
}

/** A message plus its attachments, as returned by GET /api/message/:id. */
export interface MessageWithAttachments extends Message {
  attachments: Attachment[];
}

/** Result returned by the cf-email relay for an outbound send. */
export interface SendResult {
  id: string;
  status: string;
}

/** Result of an AI draft generation (POST /api/ai/draft). */
export interface AiDraftResult {
  subject: string;
  text: string;
  html: string;
  /** Model identifier that produced the draft. */
  model: string;
}

// ── API response envelopes ──

export interface ThreadsResponse {
  threads: Thread[];
}
export interface MessageResponse {
  message: MessageWithAttachments;
}
export interface SearchResponse {
  results: Message[];
}
export interface SendResponse {
  result: SendResult;
}
export interface AiDraftResponse {
  draft: AiDraftResult;
}

/** Body for POST /api/send (mirror of server SendRequest). */
export interface SendRequest {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  threadId?: string;
  mailboxId?: string;
}

/** Body for POST /api/ai/draft (mirror of server AiDraftRequest). */
export interface AiDraftRequest {
  threadId: string;
  history: Array<{
    direction: Direction;
    from: string;
    subject: string | null;
    text: string;
    date: EpochMs;
  }>;
  instruction?: string;
  tone?: string;
}
