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
  SendRequest,
  SendResult,
} from "../types";
import { sendViaCfEmail, CfEmailError } from "../lib/cfemail";
import {
  getThread,
  getMailboxByAddress,
  insertOutboundMessage,
  insertSendLog,
  insertAudit,
  type ThreadWithMessages,
  type MessageWithAttachments,
} from "../db";

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
  threadId: string | null;
}

/** Parse + validate the POST body. Returns an error string when invalid. */
function validate(raw: unknown): ValidatedBody | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "invalid body" };
  const b = raw as Record<string, unknown>;

  const to = parseAddresses(b.to);
  if (to.length === 0) return { error: "at least one recipient is required" };

  if (typeof b.subject !== "string" || b.subject.trim().length === 0) {
    return { error: "subject is required" };
  }

  const text = typeof b.text === "string" && b.text.length > 0 ? b.text : null;
  const html = typeof b.html === "string" && b.html.length > 0 ? b.html : null;
  if (text === null && html === null) {
    return { error: "a text or html body is required" };
  }

  return {
    to,
    cc: parseAddresses(b.cc),
    bcc: parseAddresses(b.bcc),
    subject: b.subject,
    text,
    html,
    threadId:
      typeof b.threadId === "string" && b.threadId.length > 0
        ? b.threadId
        : null,
  };
}

/** Coerce unknown into EmailAddress[]; tolerate string | {address} | array. */
function parseAddresses(input: unknown): EmailAddress[] {
  if (input == null) return [];
  const arr = Array.isArray(input) ? input : [input];
  const out: EmailAddress[] = [];
  for (const item of arr) {
    if (typeof item === "string") {
      const address = item.trim();
      if (isEmail(address)) out.push({ address });
    } else if (item && typeof item === "object" && "address" in item) {
      const address = String((item as { address: unknown }).address).trim();
      if (isEmail(address)) {
        const name = (item as { name?: unknown }).name;
        out.push(
          typeof name === "string" && name.length > 0
            ? { address, name }
            : { address },
        );
      }
    }
  }
  return out;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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

/**
 * Derive RFC-5322 threading from the thread being replied to.
 * In-Reply-To = the last message's Message-ID; References = prior chain + it.
 * Falls back to no threading when there is no thread / no referencable id, or
 * when the caller does not own the thread's mailbox.
 */
async function deriveThreading(
  env: Env,
  threadId: string | null,
  mailbox: Mailbox,
): Promise<Threading> {
  const empty: Threading = { inReplyTo: null, references: null, thread: null };
  if (!threadId) return empty;

  let loaded: ThreadWithMessages | null;
  try {
    loaded = await getThread(env, threadId);
  } catch {
    // A threading lookup failure must not block a legitimate send.
    return empty;
  }
  if (!loaded || loaded.mailbox_id !== mailbox.id) return empty;

  const last = [...loaded.messages]
    .reverse()
    .find(
      (m: MessageWithAttachments) =>
        typeof m.message_id === "string" && m.message_id.length > 0,
    );
  if (!last || !last.message_id) {
    return { inReplyTo: null, references: null, thread: loaded };
  }

  const inReplyTo = last.message_id;
  const priorRefs =
    typeof last.references === "string" && last.references.length > 0
      ? last.references.split(/\s+/).filter(Boolean)
      : [];
  const references = [...priorRefs, inReplyTo].join(" ");
  return { inReplyTo, references, thread: loaded };
}

/** Build a minimal RFC-822 .eml for archival to R2 (no attachments in v1). */
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

/** KV key mapping a client Idempotency-Key → its prior send result. */
function idemKey(mailboxId: string, clientKey: string): string {
  return `send_idem:${mailboxId}:${clientKey}`;
}

/** Read a prior idempotent result, tolerating KV/parse failure (returns null). */
async function readIdem(
  env: Env,
  mailboxId: string,
  clientKey: string,
): Promise<{ id: string; status: string } | null> {
  try {
    const raw = await env.MAIL_KV.get(idemKey(mailboxId, clientKey));
    if (!raw) return null;
    return JSON.parse(raw) as { id: string; status: string };
  } catch {
    return null;
  }
}

/** Build the send sub-router. Owns POST /send. */
export function sendRoutes(): Hono<AccessEnv> {
  const app = new Hono<AccessEnv>();

  app.post("/send", async (c) => {
    const user = c.get("user");

    // Resolve the caller's mailbox; `from` is forced to this address.
    let mailbox: Mailbox | null;
    try {
      mailbox = await getMailboxByAddress(c.env, user.email);
    } catch {
      return c.json({ error: "Unable to resolve your mailbox." }, 500);
    }
    if (!mailbox) {
      return c.json({ error: "No mailbox is provisioned for this account." }, 403);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body." }, 400);
    }

    const validated = validate(raw);
    if ("error" in validated) {
      return c.json({ error: validated.error }, 400);
    }

    // Idempotency (optional): replay a prior result for the same client key so a
    // retry loop cannot multiply real sends against the 1000/day domain cap.
    const clientIdemKey = (c.req.header("Idempotency-Key") ?? "").trim();
    if (clientIdemKey) {
      const prior = await readIdem(c.env, mailbox.id, clientIdemKey);
      if (prior) {
        return c.json({ ok: true, id: prior.id, status: prior.status }, 200);
      }
    }

    // Rate limit: reserve a per-mailbox send slot before contacting the relay.
    if (!(await allowSend(c.env, mailbox.id))) {
      return c.json(
        { error: "Send rate limit reached for this mailbox. Try again later." },
        429,
      );
    }

    const ip = c.req.header("CF-Connecting-IP") ?? null;

    // Threading comes from the server's view of the thread, never the client.
    const { inReplyTo, references, thread } = await deriveThreading(
      c.env,
      validated.threadId,
      mailbox,
    );

    const idempotencyKey = crypto.randomUUID();
    const localMessageId = `<${idempotencyKey}@movo.com.my>`;
    const toAddresses = validated.to.map((a) => a.address);

    const sendReq: SendRequest = {
      from: {
        address: mailbox.address,
        ...(mailbox.display_name ? { name: mailbox.display_name } : {}),
      },
      to: validated.to,
      cc: validated.cc,
      bcc: validated.bcc,
      subject: validated.subject,
      ...(validated.text !== null ? { text: validated.text } : {}),
      ...(validated.html !== null ? { html: validated.html } : {}),
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
      await safeFailLog(c.env, {
        idempotencyKey,
        toAddresses,
        subject: validated.subject,
        error: err instanceof Error ? err.message : "send failed",
      });
      await safeAudit(c.env, user, mailbox, "send.failed", ip, {
        relayStatus: relayStatus ?? null,
      });
      // Suppression / bad recipient → 422 (client-fixable); other relay or
      // network errors → 502 (upstream failure).
      const status =
        isSuppression ||
        (err instanceof CfEmailError && err.status >= 400 && err.status < 500)
          ? 422
          : 502;
      return c.json(
        {
          error: isSuppression
            ? "Recipient is suppressed or blocked."
            : "Failed to send the message.",
        },
        status,
      );
    }

    // ── relay returned 2xx but the status may still be a suppression ───────
    if (SUPPRESSED_STATUSES.has(result.status)) {
      await safeFailLog(c.env, {
        idempotencyKey,
        toAddresses,
        subject: validated.subject,
        error: `relay status: ${result.status}`,
        providerId: result.id,
      });
      await safeAudit(c.env, user, mailbox, "send.suppressed", ip, {
        relayStatus: result.status,
      });
      return c.json(
        { error: "Recipient is suppressed or blocked.", status: result.status },
        422,
      );
    }

    // ── success: persist message + send_log + archive .eml ────────────────
    let messageRowId: string | null = null;
    try {
      const eml = buildEml(sendReq, localMessageId, inReplyTo, references);
      const r2RawKey = `msg/out/${idempotencyKey}.eml`;
      try {
        await c.env.MAIL_R2.put(r2RawKey, eml, {
          httpMetadata: { contentType: "message/rfc822" },
        });
      } catch {
        // R2 archival is best-effort; never block a successful send on it.
      }

      messageRowId = await insertOutboundMessage(c.env, {
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
        ccAddresses: validated.cc.map((a) => a.address),
        bccAddresses: validated.bcc.map((a) => a.address),
        subject: validated.subject,
        text: validated.text,
        html: validated.html,
        snippet: makeSnippet(validated.text, validated.html),
        hasAttachments: false,
        date: Date.now(),
      });

      await insertSendLog(c.env, {
        messageId: messageRowId,
        idempotencyKey,
        providerId: result.id,
        status: "sent",
        toAddresses,
        subject: validated.subject,
        error: null,
      });

      await safeAudit(c.env, user, mailbox, "send.ok", ip, {
        providerId: result.id,
      });
    } catch (err) {
      // The mail WAS sent; only persistence failed. Record a failed log row so
      // the discrepancy is visible, but still report success to the caller.
      await safeFailLog(c.env, {
        idempotencyKey,
        toAddresses,
        subject: validated.subject,
        error:
          "sent but failed to persist: " +
          (err instanceof Error ? err.message : "unknown"),
        providerId: result.id,
        messageId: messageRowId,
      });
    }

    // Record the idempotent result so a replayed key returns this same outcome.
    if (clientIdemKey) {
      try {
        await c.env.MAIL_KV.put(
          idemKey(mailbox.id, clientIdemKey),
          JSON.stringify({ id: result.id, status: result.status }),
          { expirationTtl: 24 * 3600 },
        );
      } catch {
        // Idempotency persistence is best-effort; never fail a sent message on it.
      }
    }

    return c.json({
      ok: true,
      id: result.id,
      status: result.status,
      messageId: messageRowId,
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
  },
): Promise<void> {
  try {
    await insertSendLog(env, {
      messageId: args.messageId ?? null,
      idempotencyKey: args.idempotencyKey,
      providerId: args.providerId ?? null,
      status: "failed",
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
