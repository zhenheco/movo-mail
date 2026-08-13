/**
 * Write API: compose + send.  (module: send)
 *
 *   POST /send → validate → enforce from = caller's mailbox → derive threading
 *   headers from the replied thread → cf-email relay → persist outbound message
 *   + send_log + archive .eml to R2.
 *
 * Suppression: if the relay reports a suppressed/blocked status (or any
 * relay/transport error), we surface a 4xx and still record a failed send_log.
 *
 * The handler never trusts a client-supplied `from`; it is always overwritten
 * with the authenticated caller's mailbox address. Mounted by src/api/routes.ts
 * via `app.route("/", sendRoutes())`, under Cloudflare Access.
 */

import { Hono } from "hono";
import type { AccessEnv } from "../middleware/access";
import type {
  Env,
  AccessUser,
  EmailAddress,
  Mailbox,
  ParsedAttachment,
  SendRequest,
  SendResult,
  SendAttemptRow,
} from "../types";
import { sendViaCfEmail, CfEmailError } from "../lib/cfemail";
import {
  getOwnedThreadForSend,
  InvalidThreadError,
  getSendableMailboxes,
  getUserByEmail,
  claimThread,
  claimSendAttempt,
  getSendAttempt,
  transitionSendAttempt,
  insertOutboundMessage,
  insertSendLog,
  insertAudit,
  canUserReadBcc,
  type ThreadWithMessages,
  type MessageWithAttachments,
  type ThreadVisibilityViewer,
} from "../db";
import {
  buildReplyAllRecipients,
  REPLY_ALL_BCC_CONFIRMATION,
} from "../lib/reply-all";

/** Relay statuses that mean "not delivered" → map to a 4xx for the caller. */
const SUPPRESSED_STATUSES = new Set([
  "suppressed",
  "blocked",
  "bounced",
  "rejected",
  "complained",
]);

/** Validated, normalized POST body. */
interface ValidatedBody {
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  text: string | null;
  html: string | null;
  attachments: ParsedAttachment[];
  threadId: string | null;
  mailboxId: string | null;
  idempotencyKey: string | null;
  replyMode: "new" | "reply" | "reply-all" | null;
  bccProvenance: "known-nonempty" | "known-empty" | "unavailable" | null;
  bccConfirmation: "confirmed-missing-original-bcc" | null;
}

export const MOVO_SEND_CONTRACT_VERSION = "movo-send-v1" as const;
const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_PAYLOAD_BYTES = 5 * 1024 * 1024;
const MAX_RECIPIENT_COUNT = 50;
const REPLY_ALL_BCC_CONFIRMATION_ERROR =
  "Reply All requires confirmation when original Bcc is unavailable.";
const RELAY_UNAVAILABLE_ERROR = "Failed to send the message.";
const RECIPIENT_SUPPRESSED_ERROR = "Recipient is suppressed or blocked.";

class ReplyAllBccConfirmationError extends Error {
  readonly code = "reply_all_bcc_confirmation_required" as const;

  constructor() {
    super(REPLY_ALL_BCC_CONFIRMATION_ERROR);
    this.name = "ReplyAllBccConfirmationError";
  }
}

class ReplyAllNoRecipientsError extends Error {
  readonly code = "reply_all_no_recipients" as const;

  constructor() {
    super("Reply All has no remaining recipients.");
    this.name = "ReplyAllNoRecipientsError";
  }
}

function sendAttemptFailureDetails(attempt: SendAttemptRow): {
  error: string;
  code: "recipient_suppressed" | "relay_unavailable" | "message_size_limit";
  httpStatus: 400 | 422 | 502;
} {
  const storedError = attempt.error ?? "";
  const suppressed =
    storedError.startsWith("recipient_suppressed:") ||
    /relay status: (suppressed|blocked|bounced|rejected|complained)$/.test(
      storedError,
    );
  if (storedError.startsWith("message_size_limit:")) {
    return {
      error: "Message exceeds the 5 MiB email limit.",
      code: "message_size_limit",
      httpStatus: 400,
    };
  }
  return suppressed
    ? {
        error: RECIPIENT_SUPPRESSED_ERROR,
        code: "recipient_suppressed",
        httpStatus: 422,
      }
    : {
        error: RELAY_UNAVAILABLE_ERROR,
        code: "relay_unavailable",
        httpStatus: 502,
      };
}

const SEND_FIELDS = new Set([
  "contract_version",
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "text",
  "html",
  "attachments",
  "headers",
  "threadId",
  "mailboxId",
  "idempotencyKey",
  "replyMode",
  "bccProvenance",
  "bccConfirmation",
]);

type ValidationCode =
  | "invalid_request"
  | "invalid_recipient"
  | "recipient_limit"
  | "invalid_attachment"
  | "attachment_limit"
  | "message_size_limit"
  | "missing_body"
  | "reply_all_bcc_confirmation_required";

interface ValidationFailure {
  error: string;
  code: ValidationCode;
}

function failure(code: ValidationCode, error: string): ValidationFailure {
  return { error, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Parse + validate the exact versioned Movo send request. */
export function validateSendBody(
  raw: unknown,
): ValidatedBody | ValidationFailure {
  if (!isRecord(raw)) {
    return failure("invalid_request", "Request body must be a JSON object.");
  }
  const b = raw;

  for (const key of Object.keys(b)) {
    if (!SEND_FIELDS.has(key)) {
      return failure("invalid_request", `Unknown send field: ${key}.`);
    }
  }
  for (const [key, value] of Object.entries(b)) {
    if (value === null) {
      return failure("invalid_request", `${key} must not be null.`);
    }
  }
  if (b.contract_version !== MOVO_SEND_CONTRACT_VERSION) {
    return failure("invalid_request", "Unsupported or missing contract_version.");
  }

  const from = hasOwn(b, "from")
    ? parseAddress(b.from)
    : undefined;
  if (from && "code" in from) return from;

  const to = parseAddresses(b.to, true);
  if ("code" in to) return to;
  const cc = parseAddresses(b.cc, false);
  if ("code" in cc) return cc;
  const bcc = parseAddresses(b.bcc, false);
  if ("code" in bcc) return bcc;
  if (to.length + cc.length + bcc.length > MAX_RECIPIENT_COUNT) {
    return failure(
      "recipient_limit",
      `A send may contain at most ${MAX_RECIPIENT_COUNT} recipients.`,
    );
  }

  if (typeof b.subject !== "string" || b.subject.trim().length === 0) {
    return failure("invalid_request", "subject is required.");
  }
  if (hasOwn(b, "text") && typeof b.text !== "string") {
    return failure("invalid_request", "text must be a string.");
  }
  if (hasOwn(b, "html") && typeof b.html !== "string") {
    return failure("invalid_request", "html must be a string.");
  }
  const text = typeof b.text === "string" && b.text.length > 0 ? b.text : null;
  const html = typeof b.html === "string" && b.html.length > 0 ? b.html : null;
  if (text === null && html === null) {
    return failure("missing_body", "a text or html body is required.");
  }

  const attachments = parseAttachments(b.attachments);
  if ("code" in attachments) return attachments;

  const headers = parseHeaders(b.headers);
  if (headers) return headers;

  const threadId = parseOptionalNonBlankString(b.threadId, "threadId");
  if ("code" in threadId) return threadId;
  const mailboxId = parseOptionalNonBlankString(b.mailboxId, "mailboxId");
  if ("code" in mailboxId) return mailboxId;
  const idempotencyKey = parseOptionalNonBlankString(
    b.idempotencyKey,
    "idempotencyKey",
  );
  if ("code" in idempotencyKey) return idempotencyKey;

  const replyMode = parseReplyMode(b);
  if ("code" in replyMode) return replyMode;
  if (
    replyMode.value === "reply-all" &&
    replyMode.bccProvenance === "unavailable" &&
    bcc.length === 0
  ) {
    return failure(
      "reply_all_bcc_confirmation_required",
      "Reply All requires at least one typed Bcc when original Bcc is unavailable.",
    );
  }

  return {
    to,
    cc,
    bcc,
    subject: b.subject.trim(),
    text,
    html,
    attachments,
    threadId: threadId.value,
    mailboxId: mailboxId.value,
    idempotencyKey: idempotencyKey.value,
    replyMode: replyMode.value,
    bccProvenance: replyMode.bccProvenance,
    bccConfirmation: replyMode.bccConfirmation,
  };
}

interface ParsedOptionalString {
  value: string | null;
}

function parseOptionalNonBlankString(
  input: unknown,
  field: string,
): ParsedOptionalString | ValidationFailure {
  if (input === undefined) return { value: null };
  if (typeof input !== "string" || input.trim().length === 0) {
    return failure("invalid_request", `${field} must be a non-blank string.`);
  }
  return { value: input.trim() };
}

function parseAddress(input: unknown): EmailAddress | ValidationFailure {
  if (!isRecord(input)) {
    return failure("invalid_recipient", "Each address must be an object.");
  }
  for (const key of Object.keys(input)) {
    if (key !== "address" && key !== "name") {
      return failure("invalid_recipient", `Unknown address field: ${key}.`);
    }
  }
  if (typeof input.address !== "string") {
    return failure("invalid_recipient", "Address must be a string.");
  }
  const address = input.address.trim();
  if (!isEmail(address)) {
    return failure("invalid_recipient", "Invalid email address.");
  }
  if (hasOwn(input, "name")) {
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      return failure("invalid_recipient", "Address name must be non-blank.");
    }
    return { address, name: input.name.trim() };
  }
  return { address };
}

function parseAddresses(
  input: unknown,
  required: boolean,
): EmailAddress[] | ValidationFailure {
  if (input === undefined) {
    return required
      ? failure("invalid_recipient", "At least one recipient is required.")
      : [];
  }
  if (!Array.isArray(input)) {
    return failure("invalid_recipient", "Recipients must be an array.");
  }
  const out: EmailAddress[] = [];
  for (const item of input) {
    const parsed = parseAddress(item);
    if ("code" in parsed) return parsed;
    out.push(parsed);
  }
  if (required && out.length === 0) {
    return failure("invalid_recipient", "At least one recipient is required.");
  }
  return out;
}

function parseHeaders(input: unknown): ValidationFailure | null {
  if (input === undefined) return null;
  if (!isRecord(input)) {
    return failure("invalid_request", "headers must be an object.");
  }
  for (const [key, value] of Object.entries(input)) {
    if (key.trim().length === 0 || typeof value !== "string") {
      return failure("invalid_request", "headers must contain string values.");
    }
  }
  return null;
}

interface ParsedReplyFields {
  value: "new" | "reply" | "reply-all" | null;
  bccProvenance: "known-nonempty" | "known-empty" | "unavailable" | null;
  bccConfirmation: "confirmed-missing-original-bcc" | null;
}

function parseReplyMode(
  body: Record<string, unknown>,
): ParsedReplyFields | ValidationFailure {
  const hasReplyMode = hasOwn(body, "replyMode");
  const hasProvenance = hasOwn(body, "bccProvenance");
  const hasConfirmation = hasOwn(body, "bccConfirmation");
  if (!hasReplyMode && (hasProvenance || hasConfirmation)) {
    return failure("invalid_request", "Reply metadata requires replyMode.");
  }
  if (!hasReplyMode) {
    return { value: null, bccProvenance: null, bccConfirmation: null };
  }
  if (
    body.replyMode !== "new" &&
    body.replyMode !== "reply" &&
    body.replyMode !== "reply-all"
  ) {
    return failure("invalid_request", "Invalid replyMode.");
  }
  if (body.replyMode !== "reply-all" && (hasProvenance || hasConfirmation)) {
    return failure("invalid_request", "Bcc metadata is only valid for Reply All.");
  }
  if (body.replyMode !== "reply-all") {
    return { value: body.replyMode, bccProvenance: null, bccConfirmation: null };
  }
  if (
    body.bccProvenance !== "known-nonempty" &&
    body.bccProvenance !== "known-empty" &&
    body.bccProvenance !== "unavailable"
  ) {
    return failure("invalid_request", "Reply All requires Bcc provenance.");
  }
  if (
    hasConfirmation &&
    body.bccConfirmation !== "confirmed-missing-original-bcc"
  ) {
    return failure(
      "reply_all_bcc_confirmation_required",
      "Invalid Reply All Bcc confirmation.",
    );
  }
  if (
    body.bccProvenance === "unavailable" &&
    body.bccConfirmation !== REPLY_ALL_BCC_CONFIRMATION
  ) {
    return failure(
      "reply_all_bcc_confirmation_required",
      REPLY_ALL_BCC_CONFIRMATION_ERROR,
    );
  }
  return {
    value: body.replyMode,
    bccProvenance: body.bccProvenance,
    bccConfirmation: hasConfirmation
      ? "confirmed-missing-original-bcc"
      : null,
  };
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  let paddingStart = -1;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 61) {
      paddingStart = i;
      break;
    }
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (!isUpper && !isLower && !isDigit && code !== 43 && code !== 47) {
      return false;
    }
  }
  if (paddingStart < 0) return true;
  const paddingLength = value.length - paddingStart;
  if (paddingLength > 2) return false;
  for (let i = paddingStart; i < value.length; i += 1) {
    if (value.charCodeAt(i) !== 61) return false;
  }
  return true;
}

function decodeBase64(value: string): Uint8Array | null {
  if (!isBase64(value)) return null;
  try {
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i += 1) {
      bytes[i] = decoded.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function parseAttachments(
  input: unknown,
): ParsedAttachment[] | ValidationFailure {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    return failure("invalid_attachment", "attachments must be an array.");
  }
  if (input.length > MAX_ATTACHMENT_COUNT) {
    return failure(
      "attachment_limit",
      `A send may contain at most ${MAX_ATTACHMENT_COUNT} attachments.`,
    );
  }

  let total = 0;
  const out: ParsedAttachment[] = [];
  for (const item of input) {
    if (!isRecord(item)) {
      return failure("invalid_attachment", "Each attachment must be an object.");
    }
    const raw = item;
    for (const key of Object.keys(raw)) {
      if (
        key !== "filename" &&
        key !== "contentType" &&
        key !== "contentBase64" &&
        key !== "contentId" &&
        key !== "inline"
      ) {
        return failure("invalid_attachment", `Unknown attachment field: ${key}.`);
      }
    }
    if (
      typeof raw.filename !== "string" ||
      raw.filename.trim().length === 0 ||
      typeof raw.contentType !== "string" ||
      raw.contentType.trim().length === 0 ||
      typeof raw.contentBase64 !== "string"
    ) {
      return failure("invalid_attachment", "Invalid attachment metadata.");
    }
    const filename = raw.filename.trim();
    const contentType = raw.contentType.trim();
    const contentBase64 = raw.contentBase64.trim();
    if (!isBase64(contentBase64)) {
      return failure("invalid_attachment", "Attachment content must be Base64.");
    }
    if (total + contentBase64.length > MAX_ATTACHMENT_PAYLOAD_BYTES) {
      return failure(
        "message_size_limit",
        "Attachments exceed the 5 MiB email limit.",
      );
    }
    if (hasOwn(raw, "inline") && typeof raw.inline !== "boolean") {
      return failure("invalid_attachment", "Attachment inline must be boolean.");
    }
    if (
      hasOwn(raw, "contentId") &&
      (typeof raw.contentId !== "string" || raw.contentId.trim().length === 0)
    ) {
      return failure("invalid_attachment", "Attachment contentId must be non-blank.");
    }
    total += contentBase64.length;
    const content = decodeBase64(contentBase64);
    if (!content || content.length === 0) {
      return failure(
        "invalid_attachment",
        "Attachment content must decode to at least one byte.",
      );
    }
    out.push({
      filename,
      contentType,
      contentId:
        typeof raw.contentId === "string"
          ? raw.contentId.trim()
          : null,
      inline: raw.inline === true,
      content,
    });
  }
  return out;
}

/** A short plaintext preview for the stored outbound copy. */
function makeSnippet(text: string | null, html: string | null): string | null {
  const source = text ?? (html ? html.replace(/<[^>]*>/g, " ") : null);
  if (!source) return null;
  const collapsed = source.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}

interface Threading {
  inReplyTo: string | null;
  references: string | null;
  thread: ThreadWithMessages | null;
}

function isValidStoredMessageId(value: string | null): value is string {
  return typeof value === "string" && /^<[^<>\s]+@[^<>\s]+>$/.test(value);
}

function parseStoredAddressBucket(
  value: string | null,
  field: string,
): EmailAddress[] {
  if (value === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidThreadError(`malformed stored ${field}`);
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => typeof entry === "string" && isEmail(entry))
  ) {
    throw new InvalidThreadError(`malformed stored ${field}`);
  }
  return parsed.map((address) => ({ address: address as string }));
}

async function normalizeStoredReplyAll(
  env: Env,
  thread: ThreadWithMessages,
  body: ValidatedBody,
  ownAddresses: readonly string[],
  viewer: ThreadVisibilityViewer,
): Promise<ValidatedBody> {
  const source = thread.messages[thread.messages.length - 1];
  if (!source || !isValidStoredMessageId(source.message_id)) {
    throw new InvalidThreadError("malformed stored message id");
  }

  if (source.references !== null && typeof source.references !== "string") {
    throw new InvalidThreadError("malformed stored references");
  }
  const referenceText = source.references?.trim() ?? "";
  const references = referenceText.split(/\s+/).filter(Boolean);
  if (references.some((reference) => !isValidStoredMessageId(reference))) {
    throw new InvalidThreadError("malformed stored references");
  }

  const sourceCanReadBcc = await canUserReadBcc(env, source.id, viewer);
  const sourceBcc =
    sourceCanReadBcc && source.bcc_addresses !== null
      ? parseStoredAddressBucket(source.bcc_addresses, "Bcc")
      : null;
  const result = buildReplyAllRecipients(
    {
      from: {
        address: source.from_address,
        ...(source.from_name ? { name: source.from_name } : {}),
      },
      to: parseStoredAddressBucket(source.to_addresses, "To"),
      cc: parseStoredAddressBucket(source.cc_addresses, "Cc"),
      bcc: sourceBcc ?? [],
      bccProvenance:
        sourceBcc === null
          ? "unavailable"
          : sourceBcc.length > 0
            ? "known-nonempty"
            : "known-empty",
    },
    ownAddresses,
    {
      bccConfirmation: body.bccConfirmation ?? undefined,
      typedBcc: body.bcc,
    },
  );
  if (!result.ok) {
    if (result.code === "reply_all_bcc_confirmation_required") {
      throw new ReplyAllBccConfirmationError();
    }
    if (result.code === "reply_all_no_recipients") {
      throw new ReplyAllNoRecipientsError();
    }
    throw new InvalidThreadError(result.code);
  }

  return {
    ...body,
    to: result.to,
    cc: result.cc,
    bcc: result.bcc,
  };
}

/**
 * Derive RFC-5322 threading from the thread being replied to.
 * In-Reply-To = the last message's Message-ID; References = prior chain + it.
 * Falls back to no threading only when there is no explicit thread id or the
 * owned thread has no referencable message id.
 */
async function deriveThreading(
  env: Env,
  threadId: string | null,
  mailbox: Mailbox,
  viewer: ThreadVisibilityViewer,
): Promise<Threading> {
  const empty: Threading = { inReplyTo: null, references: null, thread: null };
  if (!threadId) return empty;

  const loaded = await getOwnedThreadForSend(env, threadId, mailbox.id, viewer);

  const last = [...loaded.messages]
    .reverse()
    .find(
      (m: MessageWithAttachments) =>
        typeof m.message_id === "string" && m.message_id.length > 0,
    );
  if (!last || !isValidStoredMessageId(last.message_id)) {
    throw new InvalidThreadError("malformed stored message id");
  }

  const inReplyTo = last.message_id;
  if (last.references !== null && typeof last.references !== "string") {
    throw new InvalidThreadError("malformed stored references");
  }
  const priorRefs = last.references?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (priorRefs.some((reference) => !isValidStoredMessageId(reference))) {
    throw new InvalidThreadError("malformed stored references");
  }
  const references = [...priorRefs, inReplyTo].join(" ");
  return { inReplyTo, references, thread: loaded };
}

/** Build a minimal RFC-822 .eml body archive; attachments are stored separately. */
function buildEml(
  req: SendRequest,
  messageId: string,
  inReplyTo: string | null,
  references: string | null,
): string {
  const lines: string[] = [];
  lines.push(`From: ${req.from.address}`);
  lines.push(`To: ${req.to.map((a) => a.address).join(", ")}`);
  if (req.cc && req.cc.length > 0) {
    lines.push(`Cc: ${req.cc.map((a) => a.address).join(", ")}`);
  }
  lines.push(`Subject: ${req.subject}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Message-ID: ${messageId}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push(
    `Content-Type: ${req.html ? "text/html" : "text/plain"}; charset=utf-8`,
  );
  lines.push("");
  lines.push(req.html ?? req.text ?? "");
  return lines.join("\r\n");
}

function bytesToBase64(content: ArrayBuffer | Uint8Array): string {
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function toOutboundAttachments(
  attachments: ParsedAttachment[],
): SendRequest["attachments"] {
  if (attachments.length === 0) return undefined;
  return attachments.map((att) => ({
    filename: att.filename,
    contentType: att.contentType ?? "application/octet-stream",
    contentBase64: bytesToBase64(att.content),
    ...(att.contentId ? { contentId: att.contentId } : {}),
    ...(att.inline ? { inline: true } : {}),
  }));
}

async function archiveAttachments(
  env: Env,
  messageId: string,
  attachments: ParsedAttachment[],
): Promise<{ attachments: ParsedAttachment[]; failed: boolean }> {
  const archived: ParsedAttachment[] = [];
  let failed = false;
  for (let i = 0; i < attachments.length; i += 1) {
    const att = attachments[i]!;
    try {
      await env.MAIL_R2.put(`att/${messageId}/${archived.length}`, att.content, {
        httpMetadata: {
          contentType: att.contentType ?? "application/octet-stream",
        },
      });
      archived.push(att);
    } catch {
      failed = true;
    }
  }
  return { attachments: archived, failed };
}

/**
 * Per-mailbox send rate limit. Conservative cap kept well under the cf-email
 * domain hard ceiling of 1000/day/domain (spec §2c) so a single mailbox — or a
 * stuck client retry loop — cannot exhaust the whole domain's deliverability
 * budget. KV is eventually-consistent → this is a soft cost/abuse guardrail.
 */
const SEND_RATE_LIMIT_MAX = 100;
const SEND_RATE_LIMIT_WINDOW_SECONDS = 3600;

function sendRateKey(mailboxId: string, windowStart: number): string {
  return `send_rl:${mailboxId}:${windowStart}`;
}

/**
 * Reserve one send slot for the mailbox (fixed-window counter in KV).
 * Returns false only when the limit is positively known to be exceeded; any KV
 * failure fails OPEN (logged) so a limiter outage never blocks a legitimate send.
 */
async function allowSend(env: Env, mailboxId: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % SEND_RATE_LIMIT_WINDOW_SECONDS);
  const key = sendRateKey(mailboxId, windowStart);

  let count = 0;
  try {
    const raw = await env.MAIL_KV.get(key);
    count = raw ? Number.parseInt(raw, 10) || 0 : 0;
  } catch (err) {
    console.error("send rate-limit read failed", err);
    return true;
  }
  if (count >= SEND_RATE_LIMIT_MAX) return false;
  try {
    await env.MAIL_KV.put(key, String(count + 1), {
      expirationTtl: SEND_RATE_LIMIT_WINDOW_SECONDS * 2,
    });
  } catch (err) {
    console.error("send rate-limit write failed", err);
  }
  return true;
}

/** Stable request identity used to reject reuse of a key for another send. */
async function canonicalSendHash(
  body: ValidatedBody,
  mailbox: Mailbox,
  thread: ThreadWithMessages | null,
  inReplyTo: string | null,
  references: string | null,
): Promise<string> {
  const canonical = JSON.stringify({
    contract_version: MOVO_SEND_CONTRACT_VERSION,
    mailboxId: mailbox.id,
    from: mailbox.address,
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    subject: body.subject,
    text: body.text,
    html: body.html,
    attachments: toOutboundAttachments(body.attachments) ?? [],
    threadId: thread?.id ?? null,
    headers: {
      ...(inReplyTo ? { "In-Reply-To": inReplyTo } : {}),
      ...(references ? { References: references } : {}),
    },
    replyMode: body.replyMode,
    bccProvenance: body.bccProvenance,
    bccConfirmation: body.bccConfirmation,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Build the send sub-router. Owns POST /send. */
export function sendRoutes(): Hono<AccessEnv> {
  const app = new Hono<AccessEnv>();

  app.post("/send", async (c) => {
    const user = c.get("user");

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        { error: "Invalid JSON body.", code: "invalid_request" },
        400,
      );
    }

    const validated = validateSendBody(raw);
    if ("code" in validated) {
      return c.json(validated, 400);
    }

    const headerIdemKey = (c.req.header("Idempotency-Key") ?? "").trim();
    if (
      headerIdemKey &&
      validated.idempotencyKey &&
      headerIdemKey !== validated.idempotencyKey
    ) {
      return c.json(
        {
          error: "Idempotency-Key header and body value must match.",
          code: "invalid_request",
        },
        400,
      );
    }

    // Resolve the caller's sendable mailboxes; `from` is forced to the row.
    let sendable: Mailbox[];
    try {
      sendable = await getSendableMailboxes(c.env, user);
    } catch {
      return c.json({ error: "Unable to resolve your mailbox." }, 500);
    }
    if (sendable.length === 0) {
      return c.json(
        {
          error: "No mailbox is provisioned for this account.",
          code: "mailbox_forbidden",
        },
        403,
      );
    }

    let mailbox: Mailbox;
    if (validated.mailboxId) {
      const found = sendable.find((m) => m.id === validated.mailboxId);
      if (!found) {
        return c.json(
          { error: "You do not own that mailbox.", code: "mailbox_forbidden" },
          403,
        );
      }
      mailbox = found;
    } else if (sendable.length === 1) {
      mailbox = sendable[0]!;
    } else {
      return c.json(
        { error: "mailboxId is required when you own multiple mailboxes." },
        400,
      );
    }

    const idempotencyKey =
      headerIdemKey || validated.idempotencyKey || crypto.randomUUID();

    const ip = c.req.header("CF-Connecting-IP") ?? null;

    let dbUserId: string | null = null;
    let isAdmin = false;
    const needsDbUser = validated.threadId !== null || mailbox.kind === "shared";
    if (needsDbUser) {
      let dbUser;
      try {
        dbUser = await getUserByEmail(c.env, user.email);
      } catch {
        if (validated.threadId !== null) {
          return c.json({ error: "Invalid thread.", code: "invalid_thread" }, 400);
        }
        return c.json({ error: "Unable to resolve your user." }, 500);
      }
      if (!dbUser) {
        if (validated.threadId !== null) {
          return c.json({ error: "Invalid thread.", code: "invalid_thread" }, 400);
        }
        return c.json({ error: "Unable to resolve your user." }, 500);
      }
      dbUserId = dbUser.id;
      isAdmin = dbUser.role === "admin";
    }
    const viewer: ThreadVisibilityViewer = { userId: dbUserId, isAdmin };

    // Threading comes from the server's view of the thread, never the client.
    let threading: Threading;
    try {
      threading = await deriveThreading(
        c.env,
        validated.threadId,
        mailbox,
        viewer,
      );
    } catch (err) {
      if (err instanceof ReplyAllBccConfirmationError) {
        return c.json(
          {
            error: err.message,
            code: err.code,
          },
          400,
        );
      }
      if (err instanceof InvalidThreadError) {
        return c.json({ error: "Invalid thread.", code: err.code }, 400);
      }
      console.error("thread lookup failed", err);
      return c.json({ error: "Unable to resolve the thread." }, 500);
    }
    const { inReplyTo, references, thread } = threading;
    let effectiveBody = validated;
    if (validated.replyMode === "reply-all") {
      if (!thread) {
        return c.json({ error: "Invalid thread.", code: "invalid_thread" }, 400);
      }
      try {
        effectiveBody = await normalizeStoredReplyAll(
          c.env,
          thread,
          validated,
          [
            user.email,
            mailbox.address,
            ...sendable
              .filter((candidate) => candidate.kind === "personal")
              .map((candidate) => candidate.address),
          ],
          viewer,
        );
      } catch (err) {
        if (err instanceof ReplyAllBccConfirmationError) {
          return c.json(
            {
              error: err.message,
              code: err.code,
            },
            400,
          );
        }
        if (err instanceof ReplyAllNoRecipientsError) {
          return c.json(
            {
              error: err.message,
              code: err.code,
            },
            400,
          );
        }
        if (err instanceof InvalidThreadError) {
          return c.json({ error: "Invalid thread.", code: err.code }, 400);
        }
        console.error("reply-all normalization failed", err);
        return c.json({ error: "Unable to normalize the reply." }, 500);
      }
    }

    let assigneeId: string | null = null;
    if (thread === null && mailbox.kind === "shared") {
      assigneeId = dbUserId;
    } else if (
      thread !== null &&
      mailbox.kind === "shared" &&
      thread.assignee_id === null &&
      dbUserId
    ) {
      try {
        await claimThread(c.env, thread.id, dbUserId);
      } catch (err) {
        console.error("thread claim failed", err);
      }
    }

    const canonicalHash = await canonicalSendHash(
      effectiveBody,
      mailbox,
      thread,
      inReplyTo,
      references,
    );
    let sendAttempt: SendAttemptRow;
    let claim;
    try {
      claim = await claimSendAttempt(c.env, {
        mailboxId: mailbox.id,
        idempotencyKey,
        canonicalHash,
      });
      sendAttempt =
        (await getSendAttempt(c.env, claim.attempt.id)) ?? claim.attempt;
    } catch {
      return c.json({ error: "Unable to record the send attempt." }, 500);
    }
    if (claim.kind === "mismatch") {
      return c.json(
        {
          error: "Idempotency-Key was already used for another request.",
          code: "idempotency_mismatch",
        },
        409,
      );
    }
    if (claim.kind === "replay" && sendAttempt.status !== "queued") {
      if (sendAttempt.status === "failed") {
        const failure = sendAttemptFailureDetails(sendAttempt);
        return c.json(
          { error: failure.error, code: failure.code },
          failure.httpStatus,
        );
      }
      if (sendAttempt.status === "pending") {
        return c.json(
          {
            ok: true,
            id: sendAttempt.provider_id ?? sendAttempt.id,
            status: "pending",
            messageId: sendAttempt.message_id,
          },
          200,
        );
      }
      return c.json(
        {
          ok: true,
          id: sendAttempt.provider_id ?? sendAttempt.id,
          status: sendAttempt.status,
          messageId: sendAttempt.message_id,
        },
        200,
      );
    }

    // Rate limit: reserve a per-mailbox send slot before contacting the relay.
    if (!(await allowSend(c.env, mailbox.id))) {
      return c.json(
        { error: "Send rate limit reached for this mailbox. Try again later." },
        429,
      );
    }

    try {
      await transitionSendAttempt(c.env, {
        id: sendAttempt.id,
        from: "queued",
        to: "pending",
      });
    } catch {
      const latest = await getSendAttempt(c.env, sendAttempt.id);
      if (latest && latest.status !== "queued") {
        if (latest.status === "failed") {
          const failure = sendAttemptFailureDetails(latest);
          return c.json(
            { error: failure.error, code: failure.code },
            failure.httpStatus,
          );
        }
        if (latest.status === "pending") {
          return c.json(
            {
              ok: true,
              id: latest.provider_id ?? latest.id,
              status: "pending",
              messageId: latest.message_id,
            },
            200,
          );
        }
        return c.json(
          {
            ok: true,
            id: latest.provider_id ?? latest.id,
            status: latest.status,
            messageId: latest.message_id,
          },
          200,
        );
      }
      return c.json({ error: "Unable to start the send attempt." }, 500);
    }

    const localMessageId = `<${idempotencyKey}@movo.com.my>`;
    const toAddresses = effectiveBody.to.map((a) => a.address);

    const sendReq: SendRequest = {
      from: {
        address: mailbox.address,
        ...(mailbox.display_name ? { name: mailbox.display_name } : {}),
      },
      to: effectiveBody.to,
      cc: effectiveBody.cc,
      bcc: effectiveBody.bcc,
      subject: effectiveBody.subject,
      ...(effectiveBody.text !== null ? { text: effectiveBody.text } : {}),
      ...(effectiveBody.html !== null ? { html: effectiveBody.html } : {}),
      ...(effectiveBody.attachments.length > 0
        ? { attachments: toOutboundAttachments(effectiveBody.attachments) }
        : {}),
      idempotencyKey,
      ...(thread ? { threadId: thread.id } : {}),
      mailboxId: mailbox.id,
      ...(inReplyTo || references
        ? {
            headers: {
              ...(inReplyTo ? { "In-Reply-To": inReplyTo } : {}),
              ...(references ? { References: references } : {}),
            },
          }
        : {}),
    };

    // ── call the relay ────────────────────────────────────────────────────
    let result: SendResult;
    try {
      result = await sendViaCfEmail(c.env, sendReq);
    } catch (err) {
      const relayStatus =
        err instanceof CfEmailError ? err.relayStatus : undefined;
      const isSuppression =
        relayStatus != null && SUPPRESSED_STATUSES.has(relayStatus);
      const isMessageTooLarge = relayStatus === "message_size_limit";
      const failureCode = isSuppression
        ? "recipient_suppressed"
        : isMessageTooLarge
          ? "message_size_limit"
          : "relay_unavailable";
      const failureMessage = err instanceof Error ? err.message : "send failed";
      await safeFailLog(c.env, {
        idempotencyKey,
        toAddresses,
        subject: effectiveBody.subject,
        error: failureMessage,
      });
      try {
        await transitionSendAttempt(c.env, {
          id: sendAttempt.id,
          from: "pending",
          to: "failed",
          error: `${failureCode}: ${failureMessage}`,
        });
      } catch {
        console.error("send attempt failure transition failed");
      }
      await safeAudit(c.env, user, mailbox, "send.failed", ip, {
        relayStatus: relayStatus ?? null,
      });
      const status = isSuppression ? 422 : isMessageTooLarge ? 400 : 502;
      return c.json(
        {
          error: isSuppression
            ? RECIPIENT_SUPPRESSED_ERROR
            : isMessageTooLarge
              ? "Message exceeds the 5 MiB email limit."
              : RELAY_UNAVAILABLE_ERROR,
          code: failureCode,
        },
        status,
      );
    }

    // ── relay returned 2xx but the status may still be a suppression ───────
    if (SUPPRESSED_STATUSES.has(result.status)) {
      const failure = `relay status: ${result.status}`;
      await safeFailLog(c.env, {
        idempotencyKey,
        toAddresses,
        subject: effectiveBody.subject,
        error: failure,
        providerId: result.id,
      });
      try {
        await transitionSendAttempt(c.env, {
          id: sendAttempt.id,
          from: "pending",
          to: "failed",
          providerId: result.id,
          error: `recipient_suppressed: ${failure}`,
        });
      } catch {
        console.error("send attempt suppression transition failed");
      }
      await safeAudit(c.env, user, mailbox, "send.suppressed", ip, {
        relayStatus: result.status,
      });
      return c.json(
        {
          error: RECIPIENT_SUPPRESSED_ERROR,
          code: "recipient_suppressed",
          status: result.status,
        },
        422,
      );
    }

    if (result.status === "failed") {
      const failure = `relay status: ${result.status}`;
      await safeFailLog(c.env, {
        idempotencyKey,
        toAddresses,
        subject: effectiveBody.subject,
        error: failure,
        providerId: result.id,
      });
      try {
        await transitionSendAttempt(c.env, {
          id: sendAttempt.id,
          from: "pending",
          to: "failed",
          providerId: result.id,
          error: `relay_unavailable: ${failure}`,
        });
      } catch {
        console.error("send attempt failure transition failed");
      }
      await safeAudit(c.env, user, mailbox, "send.failed", ip, {
        relayStatus: result.status,
      });
      return c.json(
        { error: RELAY_UNAVAILABLE_ERROR, code: "relay_unavailable" },
        502,
      );
    }

    if (result.status === "pending") {
      try {
        await transitionSendAttempt(c.env, {
          id: sendAttempt.id,
          from: "pending",
          to: "pending",
          providerId: result.id,
          messageId: result.messageId ?? null,
        });
      } catch {
        // The local state is already pending; a replay will remain fail-closed
        // if the provider id cannot be recorded.
        console.error("send attempt pending update failed");
      }
      return c.json(
        {
          ok: true,
          id: result.id,
          status: "pending",
          messageId: result.messageId ?? null,
        },
        200,
      );
    }

    // ── success: persist message + send_log + archive .eml ────────────────
    let messageRowId: string | null = null;
    let persistenceSucceeded = false;
    try {
      const outboundMessageId = crypto.randomUUID();
      const eml = buildEml(sendReq, localMessageId, inReplyTo, references);
      const r2RawKey = `msg/${outboundMessageId}.eml`;
      const archiveResult = await archiveAttachments(
        c.env,
        outboundMessageId,
        effectiveBody.attachments,
      );
      if (archiveResult.failed) {
        throw new Error("attachment archival failed");
      }
      try {
        await c.env.MAIL_R2.put(r2RawKey, eml, {
          httpMetadata: { contentType: "message/rfc822" },
        });
      } catch {
        throw new Error("raw EML archival failed");
      }

      messageRowId = await insertOutboundMessage(c.env, {
        id: outboundMessageId,
        // Reply → attach to the existing thread; brand-new send → omit so the
        // data layer mints a real thread row (avoids a phantom-thread FK error
        // that would silently drop the persisted sent copy).
        ...(thread ? { threadId: thread.id } : {}),
        mailboxId: mailbox.id,
        messageId: localMessageId,
        inReplyTo,
        references,
        fromAddress: mailbox.address,
        fromName: mailbox.display_name ?? null,
        toAddresses,
        ccAddresses: effectiveBody.cc.map((a) => a.address),
        bccAddresses: effectiveBody.bcc.map((a) => a.address),
        subject: effectiveBody.subject,
        text: effectiveBody.text,
        html: effectiveBody.html,
        snippet: makeSnippet(effectiveBody.text, effectiveBody.html),
        hasAttachments: archiveResult.attachments.length > 0,
        attachments: archiveResult.attachments,
        date: Date.now(),
        ...(assigneeId ? { assigneeId } : {}),
      });

      await insertSendLog(c.env, {
        messageId: messageRowId,
        idempotencyKey,
        providerId: result.id,
        status: "sent",
        toAddresses,
        subject: effectiveBody.subject,
        error: null,
      });

      await safeAudit(c.env, user, mailbox, "send.ok", ip, {
        providerId: result.id,
      });
      persistenceSucceeded = true;
    } catch (err) {
      // The mail WAS sent; only persistence failed. Record a failed log row so
      // the discrepancy is visible, but still report success to the caller.
      await safeFailLog(c.env, {
        idempotencyKey,
        toAddresses,
        subject: effectiveBody.subject,
        error:
          "sent but failed to persist: " +
          (err instanceof Error ? err.message : "unknown"),
        providerId: result.id,
        messageId: messageRowId,
        status: "sent_unarchived",
      });
    }

    try {
      await transitionSendAttempt(c.env, {
        id: sendAttempt.id,
        from: "pending",
        to: persistenceSucceeded ? "sent" : "sent_unarchived",
        providerId: result.id,
        messageId: result.messageId ?? messageRowId,
        ...(persistenceSucceeded
          ? {}
          : { error: "sent but failed to persist" }),
      });
    } catch {
      console.error("send attempt success transition failed");
    }

    const status = persistenceSucceeded ? "sent" : "sent_unarchived";
    return c.json({
      ok: true,
      id: result.id,
      status,
      messageId: result.messageId ?? messageRowId,
    });
  });

  return app;
}

/** Insert a `failed` send_log row, swallowing any DB error. */
async function safeFailLog(
  env: Env,
  args: {
    idempotencyKey: string;
    toAddresses: string[];
    subject: string;
    error: string;
    providerId?: string | null;
    messageId?: string | null;
    status?: "failed" | "sent_unarchived";
  },
): Promise<void> {
  try {
    await insertSendLog(env, {
      messageId: args.messageId ?? null,
      idempotencyKey: args.idempotencyKey,
      providerId: args.providerId ?? null,
      status: args.status ?? "failed",
      toAddresses: args.toAddresses,
      subject: args.subject,
      error: args.error,
    });
  } catch {
    // Logging failure must not mask the original outcome.
  }
}

/** Write an audit row, swallowing any DB error. */
async function safeAudit(
  env: Env,
  user: AccessUser,
  mailbox: Mailbox,
  action: string,
  ip: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await insertAudit(env, {
      userId: user.sub,
      actorEmail: user.email,
      action,
      targetType: "mailbox",
      targetId: mailbox.id,
      detail,
      ip,
    });
  } catch {
    // Audit failure must not affect the response.
  }
}
