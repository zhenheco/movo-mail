/**
 * cf-email relay client — Movo Mail's only outbound email path.
 *
 * All outbound mail goes through the shared cf-email Worker (which fronts
 * MailChannels). This module MUST NOT call MailChannels/Resend/SES directly.
 *
 * Pure transport: no DB writes here. Persistence + suppression handling live in
 * src/api/send.ts.
 */

import type {
  CfEmailRelayStatus,
  Env,
  SendRequest,
  SendResult,
} from "../types";

/** Thrown when the cf-email relay request fails (non-2xx or network error). */
export class CfEmailError extends Error {
  /** HTTP status from the relay, or 0 for transport/network failures. */
  readonly status: number;
  /** Best-effort relay status string ("suppressed" / "blocked" / etc.), if any. */
  readonly relayStatus?: string;

  constructor(message: string, status: number, relayStatus?: string) {
    super(message);
    this.name = "CfEmailError";
    this.status = status;
    this.relayStatus = relayStatus;
  }
}

/** Versioned wire contract emitted to the canonical cf-email relay. */
export const CF_EMAIL_RELAY_CONTRACT_VERSION = "cf-mail-send-v2" as const;
export const MAX_RELAY_MESSAGE_BYTES = 5 * 1024 * 1024;
const MAX_RELAY_RECIPIENT_COUNT = 50;
const MAX_RELAY_ATTACHMENT_COUNT = 32;
const RECOGNIZED_RELAY_STATUSES: readonly CfEmailRelayStatus[] = [
  "sent",
  "pending",
  "failed",
  "suppressed",
  "blocked",
  "bounced",
  "rejected",
  "complained",
];
const RECOGNIZED_RELAY_STATUS_SET = new Set<string>(
  RECOGNIZED_RELAY_STATUSES,
);
const MIME_ALTERNATIVE_BOUNDARY = "=_movo_mail_cfemail_alternative_v2";
const MIME_MIXED_BOUNDARY = "=_movo_mail_cfemail_mixed_v2";
const MIME_LINE_LENGTH = 76;
const CRLF = "\r\n";

/** Shape of the JSON body the cf-email Worker `/send` endpoint expects. */
export interface CfEmailSendBody {
  relay_contract_version: typeof CF_EMAIL_RELAY_CONTRACT_VERSION;
  to: string[];
  cc?: string[];
  bcc?: string[];
  from: string;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: Array<{
    filename: string;
    type: string;
    content: string;
    disposition: "attachment" | "inline";
    contentId?: string;
  }>;
}

/** Map the local address objects to the relay's dedicated recipient fields. */
function recipientAddresses(list: SendRequest["to"]): string[] {
  return list.map((recipient) => recipient.address);
}

/** Drop undefined header values so we never serialize `"In-Reply-To": null`. */
function compactHeaders(
  headers: SendRequest["headers"],
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (
      typeof v === "string" &&
      v.length > 0 &&
      k.trim().toLowerCase() !== "bcc"
    ) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, CRLF);
}

function safeHeaderValue(value: string): string {
  return normalizeLineEndings(value).replace(/[\r\n]+/g, " ");
}

function safeMimeParameter(value: string): string {
  return safeHeaderValue(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function encodeBase64(binary: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const chunks: string[] = [];
  const chunkSize = 0x6000;

  for (let start = 0; start < binary.length; start += chunkSize) {
    const end = Math.min(binary.length, start + chunkSize);
    let encoded = "";
    for (let i = start; i < end; i += 3) {
      const first = binary.charCodeAt(i);
      const hasSecond = i + 1 < end;
      const hasThird = i + 2 < end;
      const second = hasSecond ? binary.charCodeAt(i + 1) : 0;
      const third = hasThird ? binary.charCodeAt(i + 2) : 0;
      encoded += alphabet.charAt(first >> 2);
      encoded += alphabet.charAt(((first & 0x03) << 4) | (second >> 4));
      encoded += hasSecond
        ? alphabet.charAt(((second & 0x0f) << 2) | (third >> 6))
        : "=";
      encoded += hasThird ? alphabet.charAt(third & 0x3f) : "=";
    }
    chunks.push(encoded);
  }
  return chunks.join("");
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0) return false;

  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;

  const dataLength = value.length - padding;
  for (let i = 0; i < dataLength; i += 1) {
    const code = value.charCodeAt(i);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (!isUpper && !isLower && !isDigit && code !== 43 && code !== 47) {
      return false;
    }
  }
  for (let i = dataLength; i < value.length; i += 1) {
    if (value.charCodeAt(i) !== 61) return false;
  }
  return padding === 0 || dataLength % 4 === 4 - padding;
}

/** Remove MIME whitespace and canonicalize valid Base64 without changing bytes. */
function normalizeBase64(value: string): string {
  const compact = value.replace(/\s+/g, "");
  if (isCanonicalBase64(compact)) return compact;
  try {
    return encodeBase64(atob(compact));
  } catch {
    // The API validator rejects malformed Base64 before this adapter. Keeping
    // the compact input here preserves the adapter's existing error boundary
    // for direct callers while still making the size calculation deterministic.
    return compact;
  }
}

function wrapBase64(value: string): string {
  const lines: string[] = [];
  for (let start = 0; start < value.length; start += MIME_LINE_LENGTH) {
    lines.push(value.slice(start, start + MIME_LINE_LENGTH));
  }
  return lines.join(CRLF);
}

function mimeBodyPart(
  boundary: string,
  contentType: string,
  content: string,
): string {
  return [
    `--${boundary}`,
    `Content-Type: ${contentType}`,
    "Content-Transfer-Encoding: 8bit",
    "",
    normalizeLineEndings(content),
  ].join(CRLF);
}

function mimeAttachmentPart(
  boundary: string,
  attachment: NonNullable<CfEmailSendBody["attachments"]>[number],
): string {
  const filename = safeMimeParameter(attachment.filename);
  return [
    `--${boundary}`,
    `Content-Type: ${safeHeaderValue(attachment.type)}; name="${filename}"`,
    `Content-Disposition: ${attachment.disposition}; filename="${filename}"`,
    ...(attachment.contentId
      ? [`Content-ID: <${safeMimeParameter(attachment.contentId)}>`]
      : []),
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(normalizeBase64(attachment.content)),
  ].join(CRLF);
}

function multipartBody(boundary: string, parts: string[]): string {
  return `${parts.join(CRLF)}${CRLF}--${boundary}--`;
}

function serializeBody(body: CfEmailSendBody): {
  contentType: string;
  content: string;
} {
  const hasText = typeof body.text === "string";
  const hasHtml = typeof body.html === "string";
  const text = body.text ?? "";
  const html = body.html ?? "";

  if (hasText && hasHtml) {
    return {
      contentType: `multipart/alternative; boundary="${MIME_ALTERNATIVE_BOUNDARY}"`,
      content: multipartBody(MIME_ALTERNATIVE_BOUNDARY, [
        mimeBodyPart(MIME_ALTERNATIVE_BOUNDARY, "text/plain; charset=UTF-8", text),
        mimeBodyPart(MIME_ALTERNATIVE_BOUNDARY, "text/html; charset=UTF-8", html),
      ]),
    };
  }

  return {
    contentType: hasHtml ? "text/html; charset=UTF-8" : "text/plain; charset=UTF-8",
    content: normalizeLineEndings(hasHtml ? html : text),
  };
}

/** Deterministic MIME representation used for the provider byte-limit guard. */
export function serializeCfEmailMessage(body: CfEmailSendBody): string {
  const hasAttachments = (body.attachments?.length ?? 0) > 0;
  const serializedBody = serializeBody(body);
  const headerLines = [
    `From: ${safeHeaderValue(body.from)}`,
    `To: ${body.to.map(safeHeaderValue).join(", ")}`,
    ...(body.cc && body.cc.length > 0
      ? [`Cc: ${body.cc.map(safeHeaderValue).join(", ")}`]
      : []),
    ...(body.bcc && body.bcc.length > 0
      ? [`Bcc: ${body.bcc.map(safeHeaderValue).join(", ")}`]
      : []),
    `Subject: ${safeHeaderValue(body.subject)}`,
    ...Object.entries(body.headers ?? {})
      .sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
      .map(([name, value]) => `${safeHeaderValue(name)}: ${safeHeaderValue(value)}`),
    "MIME-Version: 1.0",
  ];

  let contentType = serializedBody.contentType;
  let content = serializedBody.content;
  if (hasAttachments) {
    const bodyPart = serializedBody.contentType.startsWith("multipart/")
      ? [
          `--${MIME_MIXED_BOUNDARY}`,
          `Content-Type: ${serializedBody.contentType}`,
          "",
          serializedBody.content,
        ].join(CRLF)
      : mimeBodyPart(MIME_MIXED_BOUNDARY, serializedBody.contentType, serializedBody.content);
    contentType = `multipart/mixed; boundary="${MIME_MIXED_BOUNDARY}"`;
    content = multipartBody(
      MIME_MIXED_BOUNDARY,
      [
        bodyPart,
        ...(body.attachments ?? []).map((attachment) =>
          mimeAttachmentPart(MIME_MIXED_BOUNDARY, attachment),
        ),
      ],
    );
  }

  return [...headerLines, `Content-Type: ${contentType}`, "", content].join(CRLF) + CRLF;
}

function serializedMessageBytes(body: CfEmailSendBody): number {
  return new TextEncoder().encode(serializeCfEmailMessage(body)).byteLength;
}

/**
 * Send one message through the cf-email relay.
 *
 * Sends Idempotency-Key as a request header (generated when the caller omits
 * one). Non-2xx responses and network errors are surfaced as a CfEmailError so the
 * caller can map them to a user-facing 4xx/5xx and a failed send_log row.
 */
export async function sendViaCfEmail(
  env: Env,
  req: SendRequest,
): Promise<SendResult> {
  const recipientCount =
    req.to.length + (req.cc?.length ?? 0) + (req.bcc?.length ?? 0);
  if (recipientCount < 1 || recipientCount > MAX_RELAY_RECIPIENT_COUNT) {
    throw new CfEmailError(
      `cf-email relay accepts 1-${MAX_RELAY_RECIPIENT_COUNT} recipients`,
      400,
      "recipient_limit",
    );
  }
  if ((req.attachments?.length ?? 0) > MAX_RELAY_ATTACHMENT_COUNT) {
    throw new CfEmailError(
      `cf-email relay accepts at most ${MAX_RELAY_ATTACHMENT_COUNT} attachments`,
      400,
      "attachment_limit",
    );
  }
  const idempotencyKey = req.idempotencyKey ?? crypto.randomUUID();

  const body: CfEmailSendBody = {
    relay_contract_version: CF_EMAIL_RELAY_CONTRACT_VERSION,
    to: recipientAddresses(req.to),
    from: req.from.address,
    subject: req.subject,
  };
  if (req.cc && req.cc.length > 0) body.cc = recipientAddresses(req.cc);
  if (req.bcc && req.bcc.length > 0) body.bcc = recipientAddresses(req.bcc);
  if (typeof req.html === "string") body.html = req.html;
  if (typeof req.text === "string") body.text = req.text;
  const headers = compactHeaders(req.headers);
  if (headers) body.headers = headers;
  if (req.attachments && req.attachments.length > 0) {
    body.attachments = req.attachments.map((att) => ({
      filename: att.filename,
      type: att.contentType,
      content: normalizeBase64(att.contentBase64),
      disposition: att.inline ? "inline" : "attachment",
      ...(att.contentId ? { contentId: att.contentId } : {}),
    }));
  }

  const messageBytes = serializedMessageBytes(body);
  if (messageBytes > MAX_RELAY_MESSAGE_BYTES) {
    throw new CfEmailError(
      `cf-email relay message is ${messageBytes} bytes; maximum is ${MAX_RELAY_MESSAGE_BYTES}`,
      400,
      "message_size_limit",
    );
  }

  const url = `${env.CF_EMAIL_ENDPOINT}/send`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": env.CF_EMAIL_API_KEY,
        "content-type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "network error";
    throw new CfEmailError(`cf-email request failed: ${reason}`, 0);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const relayStatus = extractStatus(payload);
    throw new CfEmailError(
      `cf-email relay returned ${response.status}`,
      response.status,
      relayStatus,
    );
  }

  return parseSuccessfulRelayPayload(payload);
}

/** Fetch delivery status for a previously-sent message (bounce/log sync). */
export async function getStatus(env: Env, id: string): Promise<SendResult> {
  const url = `${env.CF_EMAIL_ENDPOINT}/status/${encodeURIComponent(id)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": env.CF_EMAIL_API_KEY },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "network error";
    throw new CfEmailError(`cf-email status request failed: ${reason}`, 0);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new CfEmailError(
      `cf-email status returned ${response.status}`,
      response.status,
      extractStatus(payload),
    );
  }

  return parseSuccessfulRelayPayload(payload);
}

function parseSuccessfulRelayPayload(payload: unknown): SendResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CfEmailError(
      "cf-email relay returned an invalid success response",
      200,
      "invalid_response",
    );
  }

  const id = (payload as { id?: unknown }).id;
  const status = (payload as { status?: unknown }).status;
  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    typeof status !== "string" ||
    status.trim().length === 0 ||
    !RECOGNIZED_RELAY_STATUS_SET.has(status)
  ) {
    throw new CfEmailError(
      "cf-email relay returned an invalid success response",
      200,
      "invalid_response",
    );
  }

  return {
    id,
    status: status as CfEmailRelayStatus,
    messageId: extractMessageId(payload),
  };
}

function extractStatus(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "status" in payload) {
    const status = (payload as { status: unknown }).status;
    if (typeof status === "string") return status;
  }
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error: unknown }).error;
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return undefined;
}

function extractMessageId(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "messageId" in payload) {
    const messageId = (payload as { messageId: unknown }).messageId;
    if (typeof messageId === "string") return messageId;
  }
  return null;
}
