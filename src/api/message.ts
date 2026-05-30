/**
 * Read route for a single message.
 *
 *   GET /message/:id  → { message: MessageWithAttachments }
 *
 * The returned `html_body` is always sanitized with DOMPurify so the SPA can
 * render it without XSS risk. The body source is, in order of preference:
 *   1. the persisted `html_body` column, else
 *   2. the raw `.eml` stored in R2 under `r2_raw_key` (best-effort), else
 *   3. null (the SPA falls back to `text_body`).
 *
 * Access is scoped: a message is only returned if it lives in a mailbox the
 * authenticated user owns.
 */

import { Hono } from "hono";
import DOMPurify from "isomorphic-dompurify";
import type { AccessEnv } from "../middleware/access";
import type { MessageWithAttachments } from "../db";
import { getMessage } from "../db";
import { userOwnsMailbox } from "./scope";

/** DOMPurify config: drop scripts, event handlers, and dangerous content. */
const FORBID_TAGS: string[] = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
];
const FORBID_ATTR: string[] = ["onerror", "onload", "onclick", "style"];

/** Sanitize an HTML fragment, returning null for empty/blank input. */
function sanitizeHtml(html: string | null): string | null {
  if (html === null || html.trim() === "") {
    return null;
  }
  // DOMPurify.sanitize returns a string when no RETURN_DOM* flag is set.
  return DOMPurify.sanitize(html, { FORBID_TAGS, FORBID_ATTR }) as string;
}

/**
 * Best-effort read of an R2-stored raw body as text. Returns null on any
 * failure so a missing/unreadable object never breaks the message view.
 */
async function readR2Body(
  env: AccessEnv["Bindings"],
  key: string | null,
): Promise<string | null> {
  if (!key) {
    return null;
  }
  try {
    const obj = await env.MAIL_R2.get(key);
    if (!obj) {
      return null;
    }
    return await obj.text();
  } catch {
    return null;
  }
}

/** Build the /message sub-router. */
export function messageRoutes(): Hono<AccessEnv> {
  const app = new Hono<AccessEnv>();

  app.get("/message/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ error: "id is required" }, 400);
    }

    const user = c.get("user");
    try {
      const message = await getMessage(c.env, id);
      if (!message) {
        return c.json({ error: "message not found" }, 404);
      }

      // Auth scoping: deny (as 404 to avoid leaking existence) if the message's
      // mailbox is not owned by the caller.
      const owns = await userOwnsMailbox(c.env, user, message.mailbox_id);
      if (!owns) {
        return c.json({ error: "message not found" }, 404);
      }

      const rawHtml =
        message.html_body ?? (await readR2Body(c.env, message.r2_raw_key));
      const sanitized: MessageWithAttachments = {
        ...message,
        html_body: sanitizeHtml(rawHtml),
      };
      return c.json({ message: sanitized });
    } catch {
      return c.json({ error: "failed to load message" }, 500);
    }
  });

  return app;
}
