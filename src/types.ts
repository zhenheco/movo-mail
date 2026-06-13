/**
 * Shared type contracts for Movo Mail.
 *
 * This file is the single source of truth for cross-module types. Module agents
 * MUST import from here and MUST NOT redefine these shapes locally.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Worker environment bindings
// ─────────────────────────────────────────────────────────────────────────────

/** All runtime bindings available to the Worker (see wrangler.toml). */
export interface Env {
  /** D1 database binding. */
  DB: D1Database;
  /** R2 bucket for raw .eml files and attachment bytes. */
  MAIL_R2: R2Bucket;
  /** KV namespace for caches / lightweight state (idempotency, etc.). */
  MAIL_KV: KVNamespace;
  /** Static SPA assets fetcher. */
  ASSETS: Fetcher;

  // ── vars (wrangler.toml [vars]) ──
  /** Base URL of the cf-email relay Worker, e.g. https://cf-email.zhenhe-co.workers.dev */
  CF_EMAIL_ENDPOINT: string;

  // ── secrets (wrangler secret put) ──
  /** x-api-key for the cf-email relay. */
  CF_EMAIL_API_KEY: string;
  /** Cloudflare Access application AUD tag. */
  CF_ACCESS_AUD: string;
  /** Cloudflare Access team domain, e.g. https://<team>.cloudflareaccess.com */
  CF_ACCESS_TEAM_DOMAIN: string;
  /** LLM provider API key used by src/lib/ai.ts. */
  AI_API_KEY: string;
  /**
   * Fallback recipient for inbound mail addressed to a NON-managed mailbox.
   *
   * The CF Email Routing catch-all points at this Worker's email() handler, so
   * every address arrives here. When the recipient is not a managed mailbox in
   * D1, the message is forwarded to this address — preserving the prior
   * catch-all behavior. A non-managed message must NEVER be dropped.
   */
  FALLBACK_FORWARD: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Common scalar aliases
// ─────────────────────────────────────────────────────────────────────────────

/** Unix epoch milliseconds (UTC). */
export type EpochMs = number;

/** Message direction relative to the mailbox. */
export type Direction = "inbound" | "outbound";

/** Outbound send lifecycle status. */
export type SendStatus = "queued" | "sent" | "failed";

/** A parsed email address with optional display name. */
export interface EmailAddress {
  address: string;
  name?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authenticated user (set on Hono context by accessAuth middleware)
// ─────────────────────────────────────────────────────────────────────────────

/** Identity extracted from a verified Cloudflare Access JWT. */
export interface AccessUser {
  /** Stable subject id from the Access token (`sub`). */
  sub: string;
  email: string;
  name?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain row types (mirror migrations/0001_init.sql)
// ─────────────────────────────────────────────────────────────────────────────

/** Coarse authorization role (mirrors users.role; see 0002_user_role.sql). */
export type UserRole = "admin" | "user";

/** Mailbox delivery model. */
export type MailboxKind = "personal" | "shared";

export interface User {
  id: string;
  email: string;
  name: string | null;
  /** 'admin' may manage mailboxes from the UI; 'user' is the default. */
  role: UserRole;
  created_at: EpochMs;
  updated_at: EpochMs;
}

export interface Mailbox {
  id: string;
  address: string;
  display_name: string | null;
  owner_id: string | null;
  kind: MailboxKind;
  created_at: EpochMs;
  updated_at: EpochMs;
}

/**
 * A mailbox row enriched for the admin management view: the owner is resolved
 * to their email (via a LEFT JOIN, so an unowned/orphaned mailbox still lists
 * with `ownerEmail: null`). camelCase because this is an API/UI-facing shape,
 * not a raw DB row.
 */
export interface AdminMailbox {
  id: string;
  address: string;
  displayName: string | null;
  ownerEmail: string | null;
  kind: MailboxKind;
}

export interface Thread {
  id: string;
  mailbox_id: string;
  subject: string | null;
  snippet: string | null;
  last_message_at: EpochMs;
  /**
   * Id of this thread's latest message (greatest date) — the message the UI
   * opens when the thread row is selected. A thread id is NOT a message id, so
   * this is the only correct value to pass to GET /message/:id. Null only for a
   * thread that has no messages yet.
   */
  last_message_id: string | null;
  assignee_id: string | null;
  message_count: number;
  /** 0/1 boolean as stored in SQLite. */
  unread: number;
  created_at: EpochMs;
  updated_at: EpochMs;
}

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
  html_body: string | null;
  r2_raw_key: string | null;
  has_attachments: number;
  unread: number;
  date: EpochMs;
  created_at: EpochMs;
}

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

export interface SendLogRow {
  id: string;
  message_id: string | null;
  idempotency_key: string;
  provider_id: string | null;
  status: SendStatus;
  /** JSON-encoded string[] as stored; parse on read. */
  to_addresses: string;
  subject: string | null;
  error: string | null;
  created_at: EpochMs;
  updated_at: EpochMs;
}

export interface AuditRow {
  id: string;
  user_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  /** JSON-encoded detail blob as stored; parse on read. */
  detail: string | null;
  ip: string | null;
  created_at: EpochMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound parsing (postal-mime → normalized shape for src/db.insertInboundMessage)
// ─────────────────────────────────────────────────────────────────────────────

/** A parsed attachment ready to be persisted to R2 + D1. */
export interface ParsedAttachment {
  filename: string;
  contentType: string | null;
  contentId: string | null;
  inline: boolean;
  /** Raw bytes of the attachment. */
  content: ArrayBuffer | Uint8Array;
}

/** Normalized inbound email after postal-mime parsing. */
export interface ParsedInbound {
  /** Recipient mailbox address this message was delivered to. */
  mailboxAddress: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string | null;
  text: string | null;
  /** Raw parsed HTML body, or null. Sanitized client-side before rendering. */
  html: string | null;
  snippet: string | null;
  /** Header Date as epoch ms; falls back to receive time. */
  date: EpochMs;
  attachments: ParsedAttachment[];
  /** Raw .eml bytes for archival to R2. */
  raw: ArrayBuffer | Uint8Array;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outbound send (src/lib/cfemail.sendViaCfEmail)
// ─────────────────────────────────────────────────────────────────────────────

/** Extra RFC-5322 headers forwarded to the cf-email relay (e.g. threading). */
export interface SendHeaders {
  "In-Reply-To"?: string;
  References?: string;
  [header: string]: string | undefined;
}

/** A request to send an outbound email via the cf-email relay. */
export interface SendRequest {
  /** Sender address (must be an allowed mailbox). */
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  /** Threading + custom headers forwarded to the relay. */
  headers?: SendHeaders;
  /** Idempotency key; relay dedupes on this. Generated if omitted. */
  idempotencyKey?: string;
  /** Thread this send belongs to, for local persistence. */
  threadId?: string;
  /** Mailbox this send originates from, for local persistence. */
  mailboxId?: string;
}

/** Result returned by the cf-email relay. */
export interface SendResult {
  id: string;
  status: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI draft (src/lib/ai.draftReply)
// ─────────────────────────────────────────────────────────────────────────────

/** Request for an AI-generated reply draft. */
export interface AiDraftRequest {
  /** Thread context the reply belongs to. */
  threadId: string;
  /**
   * Prior messages (oldest → newest) used as context.
   *
   * NOTE: the API route (src/api/ai.ts) IGNORES any client-supplied value and
   * always derives this from the server-side thread, so the drafted content
   * matches what the guardrails were evaluated against. It is required at the
   * lib boundary (draftReply consumes it) but optional on the wire.
   */
  history: Array<{
    direction: Direction;
    from: string;
    subject: string | null;
    text: string;
    date: EpochMs;
  }>;
  /** Optional freeform instruction, e.g. "decline politely". */
  instruction?: string;
  /** Desired tone, e.g. "professional", "friendly". */
  tone?: string;
}

/** Result of an AI draft generation. */
export interface AiDraftResult {
  subject: string;
  text: string;
  html: string;
  /** Model identifier that produced the draft. */
  model: string;
}
