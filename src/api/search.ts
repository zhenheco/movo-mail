/**
 * Search route.
 *
 *   GET /search?q=<query>&mailbox=<id?>  → { results: Message[] }
 *
 * Auth scoping rules:
 *   - if `mailbox` is supplied, the user must own it (else 403) and results are
 *     scoped to that mailbox at the db layer;
 *   - if `mailbox` is omitted, results are filtered to the user's owned
 *     mailboxes after the search so cross-mailbox data never leaks.
 */

import { Hono } from "hono";
import type { AccessEnv } from "../middleware/access";
import type { Message } from "../types";
import { searchMessages } from "../db";
import { getOwnedMailboxIds, userOwnsMailbox } from "./scope";

/** Build the /search sub-router. */
export function searchRoutes(): Hono<AccessEnv> {
  const app = new Hono<AccessEnv>();

  app.get("/search", async (c) => {
    const q = c.req.query("q");
    if (!q || q.trim() === "") {
      return c.json({ error: "q is required" }, 400);
    }

    const mailboxId = c.req.query("mailbox") ?? c.req.query("mailboxId");
    const user = c.get("user");

    try {
      if (mailboxId) {
        const owns = await userOwnsMailbox(c.env, user, mailboxId);
        if (!owns) {
          return c.json({ error: "forbidden" }, 403);
        }
        const results = await searchMessages(c.env, q, mailboxId);
        return c.json({ results });
      }

      // No mailbox scope requested: search broadly, then filter to owned ones.
      const owned = await getOwnedMailboxIds(c.env, user);
      const all = await searchMessages(c.env, q);
      const results = all.filter((m: Message) => owned.has(m.mailbox_id));
      return c.json({ results });
    } catch {
      return c.json({ error: "search failed" }, 500);
    }
  });

  return app;
}
