/**
 * Identity route — exposes the authenticated user's own identity + role flag.
 *
 *   GET /me → { email, isAdmin }
 *
 * `isAdmin` is derived server-side from the users.role column (resolved by the
 * verified Access email), never from anything the client supplies — the SPA uses
 * it only to decide whether to render the admin mailbox-management surface; the
 * admin API itself re-checks the role on every request (see src/api/admin.ts).
 *
 * The role is read-only here: there is deliberately no endpoint to change a
 * user's role (roles are seeded out-of-band), so this route cannot be used for
 * privilege escalation.
 */

import { Hono } from "hono";
import type { AccessEnv } from "../middleware/access";
import { getUserRole } from "../db";

/** Build the /me sub-router. */
export function meRoutes(): Hono<AccessEnv> {
  const app = new Hono<AccessEnv>();

  app.get("/me", async (c) => {
    const user = c.get("user");
    try {
      const role = await getUserRole(c.env, user.email);
      return c.json({ email: user.email, isAdmin: role === "admin" });
    } catch {
      // db guard() already logs detail; surface a friendly, render-safe message.
      return c.json({ error: "Unable to load your account." }, 500);
    }
  });

  return app;
}
