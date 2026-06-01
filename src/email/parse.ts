/**
 * Pure MIME → ParsedInbound normalization.
 *
 * Kept separate from the I/O handler (inbound.ts) so the parsing logic is
 * trivially unit-testable and the handler stays focused on R2/D1 side effects.
 * Parsed HTML is stored as-is; rendering sanitization happens client-side with
 * browser DOMPurify in MessageBody.tsx because workerd has no DOM.
 */

import PostalMime from "postal-mime";
import type { Address as PmAddress, Email } from "postal-mime";
import type {
  EmailAddress,
  EpochMs,
  ParsedAttachment,
  ParsedInbound,
} from "../types";

/** Max characters kept for the preview snippet. */
const SNIPPET_MAX = 200;

/**
 * Flatten a postal-mime Address (which may be a single mailbox or a group)
 * into a list of {address, name}. Group members are expanded; entries without
 * an address are dropped.
 */
function flattenAddress(addr: PmAddress | undefined): EmailAddress[] {
  if (!addr) return [];
  if ("group" in addr && Array.isArray(addr.group)) {
    return addr.group
      .filter((m): m is { name: string; address: string; group?: undefined } =>
        Boolean(m && m.address),
      )
      .map((m) => normalizeOne(m.address, m.name));
  }
  if ("address" in addr && addr.address) {
    return [normalizeOne(addr.address, addr.name)];
  }
  return [];
}

function flattenAddressList(list: PmAddress[] | undefined): EmailAddress[] {
  if (!list || list.length === 0) return [];
  return list.flatMap((a) => flattenAddress(a));
}

/** Build an EmailAddress, dropping empty display names (postal-mime uses ""). */
function normalizeOne(address: string, name: string | undefined): EmailAddress {
  const trimmed = (name ?? "").trim();
  return trimmed.length > 0
    ? { address: address.trim(), name: trimmed }
    : { address: address.trim() };
}

/** Parse a References header (space/newline separated message-ids) into a list. */
function parseReferences(refs: string | undefined): string[] {
  if (!refs) return [];
  return refs
    .split(/\s+/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/** Resolve the message Date header to epoch ms, falling back to a default. */
function parseDate(date: string | undefined, fallback: EpochMs): EpochMs {
  if (!date) return fallback;
  const parsed = Date.parse(date);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Build a short plaintext preview from text or (stripped) HTML. */
function buildSnippet(text: string | null, html: string | null): string | null {
  const source =
    text && text.trim().length > 0
      ? text
      : html
        ? html.replace(/<[^>]*>/g, " ")
        : null;
  if (!source) return null;
  const collapsed = source.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > SNIPPET_MAX
    ? collapsed.slice(0, SNIPPET_MAX)
    : collapsed;
}

/** Coerce postal-mime attachment content to raw bytes for R2 storage. */
function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  return new Uint8Array(content);
}

function normalizeAttachments(email: Email): ParsedAttachment[] {
  return (email.attachments ?? []).map((a, i) => ({
    filename: a.filename && a.filename.length > 0 ? a.filename : `attachment-${i}`,
    contentType: a.mimeType ?? null,
    contentId: a.contentId ?? null,
    inline: a.disposition === "inline" || a.related === true,
    content: toBytes(a.content),
  }));
}

/**
 * Parse raw .eml bytes into a normalized ParsedInbound.
 *
 * @param raw            Raw message bytes (.eml).
 * @param mailboxAddress Envelope recipient (the mailbox this was delivered to).
 * @param receivedAt     Receive timestamp used when the Date header is absent.
 */
export async function parseInbound(
  raw: Uint8Array,
  mailboxAddress: string,
  receivedAt: EpochMs,
): Promise<ParsedInbound> {
  const email = await PostalMime.parse(raw);

  const from = flattenAddress(email.from)[0] ?? { address: "" };
  const text = email.text ?? null;
  const html = email.html && email.html.length > 0 ? email.html : null;

  return {
    mailboxAddress,
    messageId: email.messageId ?? null,
    inReplyTo: email.inReplyTo ?? null,
    references: parseReferences(email.references),
    from,
    to: flattenAddressList(email.to),
    cc: flattenAddressList(email.cc),
    bcc: flattenAddressList(email.bcc),
    subject: email.subject ?? null,
    text,
    html,
    snippet: buildSnippet(text, html),
    date: parseDate(email.date, receivedAt),
    attachments: normalizeAttachments(email),
    raw,
  };
}
