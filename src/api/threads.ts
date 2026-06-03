/**
 * Read routes for threads.
 *
 *   GET /threads?mailbox=<id>  → { threads: Thread[] }
 *   GET /threads/all           → { threads: Thread[] }  (unified across owned)
 *
 * Scoped by the authenticated user: a 403 is returned if the user does not own
 * the requested mailbox, so one user can never enumerate another mailbox. The
 * /all variant is inherently owner-scoped (it resolves by the verified email),
 * so it needs no per-mailbox ownership check.
 */

import { Hono } from "hono";
import type { AccessEnv } from "../middleware/access";
import { getThreads, getThreadsForOwner } from "../db";
import { userOwnsMailbox } from "./scope";

/** Build the /threads sub-router. */
export function threadRoutes(): Hono<AccessEnv> {
  const app = new Hono<AccessEnv>();

  // Unified inbox: threads across every mailbox the caller owns. Registered
  // before the param-less /threads handler; a distinct static path so there is
  // no routing ambiguity.
  app.get("/threads/all", async (c) => {
    const user = c.get("user");
    try {
      const threads = await getThreadsForOwner(c.env, user.email);
      return c.json({ threads });
    } catch {
      return c.json({ error: "failed to load threads" }, 500);
    }
  });

  app.get("/threads", async (c) => {
    // Accept both `mailbox` (spec) and legacy `mailboxId` for compatibility.
    const mailboxId = c.req.query("mailbox") ?? c.req.query("mailboxId");
    if (!mailboxId) {
      return c.json({ error: "mailbox is required" }, 400);
    }

    const user = c.get("user");
    try {
      const owns = await userOwnsMailbox(c.env, user, mailboxId);
      if (!owns) {
        // Never reveal whether the mailbox exists; just deny.
        return c.json({ error: "forbidden" }, 403);
      }
      const threads = await getThreads(c.env, mailboxId);
      return c.json({ threads });
    } catch {
      return c.json({ error: "failed to load threads" }, 500);
    }
  });

  return app;
}
