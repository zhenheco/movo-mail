/**
 * Read route for a single message.
 *
 *   GET /message/:id  → { message: MessageWithAttachments }
 *
 * The returned `html_body` is the persisted parsed HTML body, or null. It is
 * sanitized client-side with browser DOMPurify in MessageBody.tsx before
 * rendering; this Worker never runs DOM sanitization because workerd has no DOM.
 *
 * Access is scoped: a message is only returned if it lives in a mailbox the
 * authenticated user owns.
 */

import { Hono } from "hono";
import type { AccessEnv } from "../middleware/access";
import { canUserReadThread, getMessage } from "../db";
import { resolveViewer } from "./scope";

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

      // Auth scoping: deny (as 404 to avoid leaking existence) if the caller
      // cannot see the thread this message belongs to.
      const viewer = await resolveViewer(c.env, user);
      const canRead = await canUserReadThread(c.env, message.thread_id, viewer);
      if (!canRead) {
        return c.json({ error: "message not found" }, 404);
      }

      return c.json({ message });
    } catch {
      return c.json({ error: "failed to load message" }, 500);
    }
  });

  return app;
}
