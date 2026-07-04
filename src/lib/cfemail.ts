/**
 * cf-email relay client — Movo Mail's only outbound email path.
 *
 * All outbound mail goes through the shared cf-email Worker (which fronts
 * MailChannels). This module MUST NOT call MailChannels/Resend/SES directly.
 *
 * Pure transport: no DB writes here. Persistence + suppression handling live in
 * src/api/send.ts.
 */

import type { Env, SendRequest, SendResult } from "../types";

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

/** Shape of the JSON body the cf-email Worker `/send` endpoint expects. */
interface CfEmailSendBody {
  to: string;
  from: string;
  subject: string;
  html?: string;
  text?: string;
  idempotencyKey: string;
  headers?: Record<string, string>;
  attachments?: Array<{
    filename: string;
    type: string;
    content: string;
    disposition: "attachment" | "inline";
    contentId?: string;
  }>;
}

/** Reduce a list of addresses to the single plain address the relay accepts. */
function primaryAddress(list: SendRequest["to"]): string {
  return list[0]?.address ?? "";
}

/** Drop undefined header values so we never serialize `"In-Reply-To": null`. */
function compactHeaders(
  headers: SendRequest["headers"],
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Send one message through the cf-email relay.
 *
 * Always attaches an idempotencyKey (generated when the caller omits one).
 * Non-2xx responses and network errors are surfaced as a CfEmailError so the
 * caller can map them to a user-facing 4xx/5xx and a failed send_log row.
 */
export async function sendViaCfEmail(
  env: Env,
  req: SendRequest,
): Promise<SendResult> {
  const idempotencyKey = req.idempotencyKey ?? crypto.randomUUID();

  const body: CfEmailSendBody = {
    to: primaryAddress(req.to),
    from: req.from.address,
    subject: req.subject,
    idempotencyKey,
  };
  if (typeof req.html === "string") body.html = req.html;
  if (typeof req.text === "string") body.text = req.text;
  const headers = compactHeaders(req.headers);
  if (headers) body.headers = headers;
  if (req.attachments && req.attachments.length > 0) {
    body.attachments = req.attachments.map((att) => ({
      filename: att.filename,
      type: att.contentType,
      content: att.contentBase64,
      disposition: att.inline ? "inline" : "attachment",
      ...(att.contentId ? { contentId: att.contentId } : {}),
    }));
  }

  const url = `${env.CF_EMAIL_ENDPOINT}/send`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": env.CF_EMAIL_API_KEY,
        "content-type": "application/json",
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

  const id = extractId(payload) ?? idempotencyKey;
  const status = extractStatus(payload) ?? "sent";
  return { id, status };
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

  return {
    id: extractId(payload) ?? id,
    status: extractStatus(payload) ?? "unknown",
  };
}

function extractId(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "id" in payload) {
    const id = (payload as { id: unknown }).id;
    if (typeof id === "string") return id;
  }
  return null;
}

function extractStatus(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "status" in payload) {
    const status = (payload as { status: unknown }).status;
    if (typeof status === "string") return status;
  }
  return undefined;
}
