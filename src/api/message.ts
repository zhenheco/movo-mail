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
import { canUserReadThread, getAttachment, getMessage } from "../db";
import { resolveViewer } from "./scope";

function downloadName(filename: string): string {
  return (filename || "attachment").replace(/["\\\r\n]/g, "_");
}

function contentDisposition(filename: string): string {
  const safe = downloadName(filename);
  const ascii = safe.replace(/[^\x20-\x7E]/g, "_");
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
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

  app.get("/attachment/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ error: "id is required" }, 400);
    }

    const user = c.get("user");
    try {
      const attachment = await getAttachment(c.env, id);
      if (!attachment) {
        return c.json({ error: "attachment not found" }, 404);
      }

      const viewer = await resolveViewer(c.env, user);
      const canRead = await canUserReadThread(
        c.env,
        attachment.thread_id,
        viewer,
      );
      if (!canRead) {
        return c.json({ error: "attachment not found" }, 404);
      }

      const object = await c.env.MAIL_R2.get(attachment.r2_key);
      if (!object) {
        return c.json({ error: "attachment not found" }, 404);
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set(
        "Content-Type",
        attachment.content_type ?? headers.get("Content-Type") ?? "application/octet-stream",
      );
      headers.set(
        "Content-Disposition",
        contentDisposition(attachment.filename),
      );
      return new Response(object.body, { headers });
    } catch {
      return c.json({ error: "failed to load attachment" }, 500);
    }
  });

  return app;
}
