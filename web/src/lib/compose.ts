/**
 * Pure helpers for the Compose panel: recipient semantics, attachment limits,
 * and assembly of the versioned Movo send request.
 */

import type {
  BccConfirmation,
  BccProvenance,
  Direction,
  EmailAddress,
  EpochMs,
  MessageWithAttachments,
  OutboundAttachment,
  ReplyMode,
  SendRequest,
} from "./types";
import { MOVO_SEND_CONTRACT_VERSION } from "./types";
import {
  isLikelyEmail,
  joinAddresses,
  parseAddresses,
  replySubject,
} from "./format";

export { MOVO_SEND_CONTRACT_VERSION } from "./types";

export const MAX_ATTACHMENT_COUNT = 10;
/** The backend counts normalized Base64 characters for this limit. */
export const MAX_ATTACHMENT_PAYLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_RECIPIENT_COUNT = 50;
export const UNAVAILABLE_BCC_CONFIRMATION: BccConfirmation =
  "confirmed-missing-original-bcc";
export const ATTACHMENT_COUNT_ERROR = `最多可附加 ${MAX_ATTACHMENT_COUNT} 個檔案。`;
export const ATTACHMENT_PAYLOAD_ERROR = "附件的 Base64 總大小不可超過 5 MiB。";
export const ATTACHMENT_EMPTY_ERROR = "無法附加空檔案。";

/** History item shape expected by POST /api/ai/draft. */
export interface DraftHistoryItem {
  direction: Direction;
  from: string;
  subject: string | null;
  text: string;
  date: EpochMs;
}

/** Editable state of the compose panel + threading metadata. */
export interface ComposeDraft {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  mode?: ReplyMode;
  /** Set when replying — drives threading + AI draft availability. */
  threadId?: string;
  mailboxId?: string;
  inReplyTo?: string;
  references?: string;
  /** Conversation history for the AI draft request. */
  history?: DraftHistoryItem[];
  /** Bcc provenance required by the versioned Reply All contract. */
  bccProvenance?: BccProvenance;
  bccConfirmation?: BccConfirmation;
  /** Attachments selected for this draft, if any. */
  attachments?: OutboundAttachment[];
}

/** A blank new-message draft. */
export function blankDraft(mailboxId: string): ComposeDraft {
  return {
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    body: "",
    mailboxId,
    mode: "new",
  };
}

/** Parse a raw token (`alice@x.com` or `Alice <alice@x.com>`). */
export function parseAddressToken(raw: string): EmailAddress | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const angled = trimmed.match(/^(?:"([^"]*)"|([^<]*?))\s*<([^<>]+)>\s*$/);
  if (angled) {
    const address = angled[3]!.trim();
    if (!isLikelyEmail(address)) {
      return null;
    }
    const name = (angled[1] ?? angled[2] ?? "").trim();
    return name.length > 0 ? { address, name } : { address };
  }
  return isLikelyEmail(trimmed) ? { address: trimmed } : null;
}

function addressKey(address: string): string {
  return address.trim().toLowerCase();
}

function selfKeySet(selfAddresses: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const raw of selfAddresses) {
    const parsed = parseAddressToken(raw);
    if (parsed) {
      keys.add(addressKey(parsed.address));
    }
  }
  return keys;
}

export interface ReplySelfMailbox {
  id?: string;
  address: string;
  kind?: string;
}

/**
 * Build the current user's addresses for Reply All self-removal. Shared
 * mailboxes stay eligible recipients; only the user's personal boxes and
 * Cloudflare Access login are removed.
 */
export function replySelfAddresses(
  mailboxes: readonly ReplySelfMailbox[],
  loginEmail?: string | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined) => {
    const parsed = raw ? parseAddressToken(raw) : null;
    if (!parsed) {
      return;
    }
    const key = addressKey(parsed.address);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(parsed.address);
    }
  };

  add(loginEmail);
  for (const mailbox of mailboxes) {
    if (mailbox.kind === "personal" || mailbox.kind === undefined) {
      add(mailbox.address);
    }
  }
  return out;
}

function parseMessageAddresses(raw: string | null): EmailAddress[] {
  return parseAddresses(raw)
    .map(parseAddressToken)
    .filter((address): address is EmailAddress => address !== null);
}

function trustedBcc(
  message: Pick<MessageWithAttachments, "bcc_addresses" | "bcc_provenance">,
): { provenance: BccProvenance; addresses: EmailAddress[] } {
  const raw = message.bcc_addresses;
  if (message.bcc_provenance === "unavailable") {
    return { provenance: "unavailable", addresses: [] };
  }
  if (message.bcc_provenance === "known-empty") {
    return { provenance: "known-empty", addresses: [] };
  }
  // A null field is the redacted/unavailable state. The backend persists a
  // known empty Bcc as the explicit JSON array [] so the UI must not collapse
  // these two states.
  if (raw === null || raw.trim().length === 0) {
    return { provenance: "unavailable", addresses: [] };
  }
  const values = parseAddresses(raw);
  if (values.length === 0) {
    return { provenance: raw.trim() === "[]" ? "known-empty" : "unavailable", addresses: [] };
  }
  const addresses = values
    .map(parseAddressToken)
    .filter((address): address is EmailAddress => address !== null);
  if (addresses.length !== values.length) {
    return { provenance: "unavailable", addresses: [] };
  }
  return { provenance: "known-nonempty", addresses };
}

export interface ReplyAllRecipients {
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  bccProvenance: BccProvenance;
}

/**
 * Reconstruct Reply All with deterministic bucket semantics:
 * sender → To, original To → To, Cc → Cc, authoritative Bcc → Bcc. The first
 * visible occurrence wins over a later Bcc occurrence, and self addresses are
 * removed case-insensitively.
 */
export function replyAllRecipients(
  message: MessageWithAttachments,
  selfAddresses: readonly string[] = [],
): ReplyAllRecipients {
  const self = selfKeySet(selfAddresses);
  const seen = new Set<string>();
  const to: EmailAddress[] = [];
  const cc: EmailAddress[] = [];
  const bcc = trustedBcc(message);

  const add = (address: EmailAddress | null, bucket: EmailAddress[]) => {
    if (!address) {
      return;
    }
    const key = addressKey(address.address);
    if (self.has(key) || seen.has(key)) {
      return;
    }
    seen.add(key);
    bucket.push(address);
  };

  const sender = parseAddressToken(message.from_address);
  const senderWithName =
    sender && message.from_name?.trim()
      ? { address: sender.address, name: message.from_name.trim() }
      : sender;
  add(senderWithName, to);

  for (const address of parseMessageAddresses(message.to_addresses)) {
    add(address, to);
  }
  for (const address of parseMessageAddresses(message.cc_addresses)) {
    add(address, cc);
  }

  // Append Bcc recipients to a separate bucket. Visible To/Cc have already
  // claimed their addresses, so a visible occurrence always wins.
  const bccRecipients: EmailAddress[] = [];
  if (bcc.provenance !== "unavailable") {
    for (const address of bcc.addresses) {
      const key = addressKey(address.address);
      if (self.has(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      bccRecipients.push(address);
    }
  }

  if (to.length === 0) {
    // With no sender/To left, promote the first remaining visible Cc and then
    // the first remaining authoritative Bcc so the request has a valid To.
    if (cc.length > 0) {
      to.push(cc.shift()!);
    } else if (bccRecipients.length > 0) {
      to.push(bccRecipients.shift()!);
    }
  }

  return {
    to,
    cc,
    bcc: bccRecipients,
    bccProvenance: bcc.provenance,
  };
}

function replyThreading(message: MessageWithAttachments): {
  inReplyTo?: string;
  references?: string;
} {
  const refs = [message.references, message.message_id]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return {
    inReplyTo: message.message_id ?? undefined,
    references: refs.length > 0 ? refs : undefined,
  };
}

function replyHistory(message: MessageWithAttachments): DraftHistoryItem[] {
  return [
    {
      direction: message.direction,
      from: message.from_address,
      subject: message.subject,
      text: message.text_body ?? "",
      date: message.date,
    },
  ];
}

/** Build a sender-only Reply draft. */
export function replyDraft(message: MessageWithAttachments): ComposeDraft {
  return {
    to: message.from_address,
    cc: "",
    bcc: "",
    subject: replySubject(message.subject),
    body: "",
    mode: "reply",
    threadId: message.thread_id,
    mailboxId: message.mailbox_id,
    ...replyThreading(message),
    history: replyHistory(message),
  };
}

/** Build an explicit Reply All draft with the Bcc provenance guard attached. */
export function replyAllDraft(
  message: MessageWithAttachments,
  selfAddresses: readonly string[] = [],
): ComposeDraft {
  const recipients = replyAllRecipients(message, selfAddresses);
  return {
    to: joinAddresses(recipients.to),
    cc: joinAddresses(recipients.cc),
    bcc: joinAddresses(recipients.bcc),
    subject: replySubject(message.subject),
    body: "",
    mode: "reply-all",
    threadId: message.thread_id,
    mailboxId: message.mailbox_id,
    ...replyThreading(message),
    history: replyHistory(message),
    bccProvenance: recipients.bccProvenance,
  };
}

/** Sum the Base64 character lengths used by the versioned request contract. */
export function attachmentPayloadLength(
  attachments: readonly OutboundAttachment[],
): number {
  return attachments.reduce(
    (total, attachment) => total + attachment.contentBase64.length,
    0,
  );
}

/**
 * Validate an incoming picker batch before reading any file. The batch is
 * atomic: if it crosses the count or payload boundary, none of it is added.
 * `incomingPayloadLengths` are estimated/normalized Base64 character lengths.
 */
export function validateAttachmentSelection(
  existingCount: number,
  incomingPayloadLengths: readonly number[],
  existingPayloadLength = 0,
): string | null {
  if (existingCount + incomingPayloadLengths.length > MAX_ATTACHMENT_COUNT) {
    return ATTACHMENT_COUNT_ERROR;
  }
  if (incomingPayloadLengths.some((length) => length <= 0)) {
    return ATTACHMENT_EMPTY_ERROR;
  }
  const incomingPayload = incomingPayloadLengths.reduce(
    (total, length) => total + length,
    0,
  );
  if (existingPayloadLength + incomingPayload > MAX_ATTACHMENT_PAYLOAD_BYTES) {
    return ATTACHMENT_PAYLOAD_ERROR;
  }
  return null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function estimatedBase64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

export async function fileToAttachment(file: File): Promise<OutboundAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error(ATTACHMENT_EMPTY_ERROR);
  }
  return {
    filename: file.name || "attachment",
    contentType: file.type || "application/octet-stream",
    contentBase64: bytesToBase64(bytes),
  };
}

export interface BuildSendArgs {
  fromAddress: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  text: string;
  attachments?: OutboundAttachment[];
  threadId?: string;
  mailboxId?: string;
  inReplyTo?: string;
  references?: string;
  mode?: ReplyMode;
  /** Alias accepted by callers that already use the wire field name. */
  replyMode?: ReplyMode;
  bccProvenance?: BccProvenance;
  bccConfirmation?: BccConfirmation;
  idempotencyKey?: string;
}

/** Assemble the exact versioned POST /api/send body. */
export function buildSendRequest(args: BuildSendArgs): SendRequest {
  const headers: Record<string, string> = {};
  if (args.inReplyTo) {
    headers["In-Reply-To"] = args.inReplyTo;
  }
  if (args.references) {
    headers.References = args.references;
  }

  const replyMode = args.replyMode ?? args.mode;
  const request: SendRequest = {
    contract_version: MOVO_SEND_CONTRACT_VERSION,
    from: { address: args.fromAddress },
    to: args.to,
    subject: args.subject.trim(),
    text: args.text,
  };
  if (args.cc && args.cc.length > 0) {
    request.cc = args.cc;
  }
  if (args.bcc && (args.bcc.length > 0 || replyMode === "reply-all")) {
    request.bcc = args.bcc;
  }
  if (Object.keys(headers).length > 0) {
    request.headers = headers;
  }
  if (args.threadId) {
    request.threadId = args.threadId;
  }
  if (args.mailboxId) {
    request.mailboxId = args.mailboxId;
  }
  if (args.attachments && args.attachments.length > 0) {
    request.attachments = args.attachments;
  }
  if (args.idempotencyKey) {
    request.idempotencyKey = args.idempotencyKey;
  }
  if (replyMode === "reply-all") {
    request.replyMode = "reply-all";
    request.bccProvenance = args.bccProvenance ?? "unavailable";
    if (args.bccConfirmation) {
      request.bccConfirmation = args.bccConfirmation;
    }
  }
  return request;
}
