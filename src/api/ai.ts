/**
 * AI draft route (spec 6.5): POST /ai/draft.
 *
 * Given a thread's context, returns an LLM-drafted reply. Guardrails:
 *   - per-mailbox rate limit (MAIL_KV counters),
 *   - 1:1 only — refuse to draft replies to mass/multi-recipient mail,
 *   - every request (allowed, rate-limited, or rejected) is written to audit_log,
 *   - the endpoint RETURNS A DRAFT ONLY. It NEVER sends (no cf-email call here);
 *     Phase 4 requires explicit human approval via POST /api/send.
 *
 * Mounted by src/api/routes.ts. The request body is the shared AiDraftRequest
 * (src/types.ts). The mailbox to rate-limit + the 1:1 check are resolved from
 * the thread, so a client cannot bypass guardrails by forging the body.
 */

import { Hono } from "hono";
import type { AccessEnv } from "../middleware/access";
import type { AiDraftRequest, Direction } from "../types";
import type { MessageWithAttachments } from "../db";
import { draftReply } from "../lib/ai";
import { canUserReadThread, getThread, insertAudit } from "../db";
import { resolveViewer } from "./scope";

/** Drafts allowed per mailbox per rolling window. Conservative internal default. */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 3600;

/** KV key for a mailbox's current-window draft counter. */
function rateKey(mailboxId: string, windowStart: number): string {
  return `ai_draft_rl:${mailboxId}:${windowStart}`;
}

/**
 * Per-mailbox fixed-window rate limit backed by MAIL_KV.
 *
 * Returns true when the request is allowed (and increments the counter). KV is
 * eventually-consistent, so this is a soft limit — acceptable for an internal
 * abuse/cost guardrail, not a security boundary.
 */
async function allowDraft(env: AccessEnv["Bindings"], mailboxId: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % RATE_LIMIT_WINDOW_SECONDS);
  const key = rateKey(mailboxId, windowStart);

  let count = 0;
  try {
    const raw = await env.MAIL_KV.get(key);
    count = raw ? Number.parseInt(raw, 10) || 0 : 0;
  } catch (err) {
    // On a KV read failure, fail OPEN for availability but log it: the AI route
    // is non-destructive (draft only), so a brief limiter outage is acceptable.
    console.error("ai rate-limit read failed", err);
    return true;
  }

  if (count >= RATE_LIMIT_MAX) return false;

  try {
    await env.MAIL_KV.put(key, String(count + 1), {
      expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
    });
  } catch (err) {
    console.error("ai rate-limit write failed", err);
    // Best-effort increment; still allow the request.
  }
  return true;
}

/** Parse a JSON-array address column into a string[], tolerating null/garbage. */
function parseAddrs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Build the AI draft history from the SERVER'S source of truth (the loaded
 * thread messages), not from any client-supplied body. This guarantees the
 * content the LLM sees is exactly the content the 1:1 + rate-limit guardrails
 * were evaluated against — a client cannot inject fabricated context.
 *
 * Message text is third-party email content and is treated as untrusted data
 * by the prompt builder (src/lib/ai.ts) — we pass it through verbatim here.
 */
function historyFromThread(
  messages: readonly MessageWithAttachments[],
): AiDraftRequest["history"] {
  return messages.map((m) => ({
    direction: m.direction as Direction,
    from: m.from_address,
    subject: m.subject,
    text: m.text_body ?? "",
    date: m.date,
  }));
}

/**
 * Build the AI sub-router. Owns POST /ai/draft.
 *
 * Runs under AccessEnv so `c.get('user')` is the authenticated actor (used for
 * the audit trail). The route is already behind Cloudflare Access in index.ts.
 */
export function aiRoutes(): Hono<AccessEnv> {
  const app = new Hono<AccessEnv>();

  app.post("/ai/draft", async (c) => {
    const user = c.get("user");

    // 1. Validate input.
    let body: AiDraftRequest;
    try {
      body = (await c.req.json()) as AiDraftRequest;
    } catch {
      return c.json({ error: "Invalid request body." }, 400);
    }
    // Only threadId is required. The reply context is derived server-side from
    // the thread (see historyFromThread); any client-supplied `history` is
    // intentionally IGNORED so guardrails and drafted content cannot diverge.
    if (!body || typeof body.threadId !== "string" || body.threadId.length === 0) {
      return c.json({ error: "threadId is required." }, 400);
    }

    // 2. Resolve the thread (also gives us the mailbox + recipients to gate on).
    let thread;
    try {
      thread = await getThread(c.env, body.threadId);
    } catch {
      return c.json({ error: "Failed to load the thread." }, 500);
    }
    if (!thread) {
      return c.json({ error: "Thread not found." }, 404);
    }

    // 2b. Ownership gate (spec §8 per-mailbox 權限隔離). The caller may only
    //     draft against a thread in a mailbox they own. Return 404 (not 403)
    //     to avoid leaking the existence of other mailboxes' threads — matching
    //     the read routes. This MUST run before allowDraft() and any audit
    //     write so a victim mailbox's rate-limit counter / audit log can never
    //     be charged for a thread the caller has no right to touch.
    let canRead: boolean;
    try {
      const viewer = await resolveViewer(c.env, user);
      canRead = await canUserReadThread(c.env, thread.id, viewer);
    } catch {
      return c.json({ error: "Failed to load the thread." }, 500);
    }
    if (!canRead) {
      return c.json({ error: "Thread not found." }, 404);
    }

    const ip = c.req.header("CF-Connecting-IP") ?? null;

    // 3. Guardrail: per-mailbox rate limit.
    const allowed = await allowDraft(c.env, thread.mailbox_id);
    if (!allowed) {
      await insertAudit(c.env, {
        userId: user.sub,
        actorEmail: user.email,
        action: "ai_draft",
        targetType: "thread",
        targetId: thread.id,
        detail: { mailboxId: thread.mailbox_id, outcome: "rate_limited" },
        ip,
      });
      return c.json(
        { error: "Draft rate limit reached for this mailbox. Try again later." },
        429,
      );
    }

    // 4. Guardrail: 1:1 only. Refuse to draft replies to mass/multi-recipient
    //    mail. We look at the latest inbound message's recipients: more than one
    //    total recipient (to + cc) means it was not a 1:1 conversation.
    const inbound = [...thread.messages]
      .reverse()
      .find((m) => m.direction === "inbound");
    if (!inbound) {
      return c.json({ error: "No inbound message to reply to." }, 422);
    }
    const recipientCount =
      parseAddrs(inbound.to_addresses).length + parseAddrs(inbound.cc_addresses).length;
    if (recipientCount > 1) {
      await insertAudit(c.env, {
        userId: user.sub,
        actorEmail: user.email,
        action: "ai_draft",
        targetType: "thread",
        targetId: thread.id,
        detail: { mailboxId: thread.mailbox_id, outcome: "rejected_not_one_to_one" },
        ip,
      });
      return c.json(
        { error: "AI drafting is only available for 1:1 conversations." },
        422,
      );
    }

    // 5. Generate the draft from the SERVER'S thread messages (not client
    //    input), so the content drafted is exactly what the guardrails above
    //    were evaluated against. DRAFT ONLY — this path never sends.
    let draft;
    try {
      draft = await draftReply(c.env, {
        threadId: thread.id,
        history: historyFromThread(thread.messages),
        instruction: body.instruction,
        tone: body.tone,
      });
    } catch (err) {
      console.error("ai draft generation failed", err);
      await insertAudit(c.env, {
        userId: user.sub,
        actorEmail: user.email,
        action: "ai_draft",
        targetType: "thread",
        targetId: thread.id,
        detail: { mailboxId: thread.mailbox_id, outcome: "provider_error" },
        ip,
      });
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to generate draft." },
        502,
      );
    }

    // 6. Audit the successful draft.
    await insertAudit(c.env, {
      userId: user.sub,
      actorEmail: user.email,
      action: "ai_draft",
      targetType: "thread",
      targetId: thread.id,
      detail: { mailboxId: thread.mailbox_id, outcome: "drafted", model: draft.model },
      ip,
    });

    return c.json({ draft });
  });

  return app;
}
