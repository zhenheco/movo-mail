/**
 * Sent-mail read route.
 *
 *   GET /sent?mailbox=<id>  → { items: SentItem[] }
 *   GET /sent?mailbox=all   → visible items across the caller's mailboxes
 *
 * Mailbox authorization mirrors the thread route: owned personal mailboxes
 * use the resolved viewer, shared mailboxes are readable with the same DB
 * visibility predicate, and every other mailbox returns an existence-neutral
 * 403.
 */

import { Hono } from "hono";
import type { AccessEnv } from "../middleware/access";
import {
  getMailboxById,
  getSentItems,
  getSentItemsForUser,
} from "../db";
import { resolveViewer, userOwnsMailbox } from "./scope";

/** Build the sent-mail sub-router. */
export function sentRoutes(): Hono<AccessEnv> {
  const app = new Hono<AccessEnv>();

  app.get("/sent", async (c) => {
    const mailboxId = c.req.query("mailbox");
    if (!mailboxId) {
      return c.json({ error: "mailbox is required" }, 400);
    }

    const user = c.get("user");
    try {
      if (mailboxId === "all") {
        const viewer = await resolveViewer(c.env, user);
        const items = await getSentItemsForUser(c.env, viewer);
        return c.json({ items });
      }

      const owns = await userOwnsMailbox(c.env, user, mailboxId);
      if (owns) {
        const viewer = await resolveViewer(c.env, user);
        const items = await getSentItems(c.env, mailboxId, viewer);
        return c.json({ items });
      }

      const mailbox = await getMailboxById(c.env, mailboxId);
      if (mailbox?.kind !== "shared") {
        // Never reveal whether the requested mailbox exists.
        return c.json({ error: "forbidden" }, 403);
      }

      const viewer = await resolveViewer(c.env, user);
      const items = await getSentItems(c.env, mailboxId, viewer);
      return c.json({ items });
    } catch {
      return c.json({ error: "failed to load sent items" }, 500);
    }
  });

  return app;
}
