/**
 * Read route exposing the authenticated user's own mailboxes.
 *
 *   GET /mailboxes → { mailboxes: { id, address, displayName, kind }[] }
 *
 * This is the primary source the SPA uses to auto-resolve which inbox to open:
 * the user never types a mailbox id. The listing is scoped to the verified
 * Access identity via `getMailboxesForUser(env, user.email)`, so a user can only
 * ever see the mailboxes they own (mirrors the scoping in src/api/scope.ts).
 *
 * Row → wire mapping is deliberate: only the fields the UI needs are returned
 * (id, address, displayName, kind), not the full Mailbox row (owner_id / timestamps).
 */

import { Hono } from "hono";
import type { AccessEnv } from "../middleware/access";
import { getMailboxesForUser } from "../db";

/** Build the /mailboxes sub-router. */
export function mailboxRoutes(): Hono<AccessEnv> {
  const app = new Hono<AccessEnv>();

  app.get("/mailboxes", async (c) => {
    const user = c.get("user");
    try {
      const boxes = await getMailboxesForUser(c.env, user.email);
      return c.json({
        mailboxes: boxes.map((m) => ({
          id: m.id,
          address: m.address,
          displayName: m.display_name ?? null,
          kind: m.kind,
        })),
      });
    } catch {
      // db guard() already logs detail; surface a friendly, render-safe message.
      return c.json({ error: "Unable to load mailboxes." }, 500);
    }
  });

  return app;
}
