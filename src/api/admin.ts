/**
 * Admin route — self-service mailbox management for users with role='admin'.
 *
 *   GET    /admin/mailboxes      → { mailboxes: AdminMailbox[] }
 *   POST   /admin/mailboxes      → 201 { id, welcomeEmailSent }   (body { address, ownerEmail, displayName? })
 *   DELETE /admin/mailboxes/:id  → 200 { ok: true } | 404
 *
 * Authorization: every /admin/* handler resolves the caller's role via
 * getUserRole(env, user.email) and returns 403 Forbidden BEFORE doing any work
 * unless the role is exactly 'admin'. This is enforced by an in-router
 * middleware mounted on `/admin/*` so a new handler cannot accidentally skip it.
 *
 * Adding a mailbox is a D1 write (createMailbox) — no Cloudflare API call,
 * because the Email Routing catch-all already routes every address to this
 * Worker, so a new D1 mailbox row immediately starts being stored. After the
 * row is committed, a best-effort welcome/activation email is sent to the
 * owner's login (Google) email via the cf-email relay (src/lib/welcome); a send
 * failure is swallowed and reported as `welcomeEmailSent: false`, never failing
 * the request.
 *
 * Role-escalation guard: there is intentionally NO endpoint to change a user's
 * role (roles are seeded out-of-band). createMailbox never accepts or sets a
 * role — an owner upserted from `ownerEmail` is always created as 'user'.
 */

import { Hono } from "hono";
import type { AccessEnv } from "../middleware/access";
import {
  getUserRole,
  listAllMailboxes,
  createMailbox,
  deleteMailbox,
  MailboxExistsError,
  type CreateMailboxInput,
} from "../db";
import { sendWelcomeEmail } from "../lib/welcome";

/**
 * Allowed mailbox address shape: a local part with no whitespace/@, on the
 * movo.com.my domain. Case-insensitive on the domain only.
 */
const MOVO_ADDRESS = /^[^@\s]+@movo\.com\.my$/i;

/** Conservative email check for the owner field (boundary validation). */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Shape of the POST /admin/mailboxes request body (pre-validation). */
interface CreateMailboxBody {
  address?: unknown;
  ownerEmail?: unknown;
  displayName?: unknown;
}

/** Build the /admin sub-router (with its authorization guard pre-mounted). */
export function adminRoutes(): Hono<AccessEnv> {
  const app = new Hono<AccessEnv>();

  // Authorization guard: runs before EVERY /admin/* handler. A non-admin (or a
  // user whose role cannot be resolved) is rejected with 403 before any work.
  app.use("/admin/*", async (c, next) => {
    const user = c.get("user");
    let role;
    try {
      role = await getUserRole(c.env, user.email);
    } catch {
      return c.json({ error: "Unable to verify your account." }, 500);
    }
    if (role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
    return;
  });

  app.get("/admin/mailboxes", async (c) => {
    try {
      const mailboxes = await listAllMailboxes(c.env);
      return c.json({ mailboxes });
    } catch {
      return c.json({ error: "Unable to load mailboxes." }, 500);
    }
  });

  app.post("/admin/mailboxes", async (c) => {
    let body: CreateMailboxBody;
    try {
      body = (await c.req.json()) as CreateMailboxBody;
    } catch {
      return c.json({ error: "Invalid request body." }, 400);
    }

    const address =
      typeof body.address === "string" ? body.address.trim() : "";
    const ownerEmail =
      typeof body.ownerEmail === "string" ? body.ownerEmail.trim() : "";
    const displayName =
      typeof body.displayName === "string" && body.displayName.trim().length > 0
        ? body.displayName.trim()
        : null;

    if (!MOVO_ADDRESS.test(address)) {
      return c.json(
        { error: "Address must be a valid @movo.com.my mailbox." },
        400,
      );
    }
    if (!EMAIL.test(ownerEmail)) {
      return c.json({ error: "A valid owner email is required." }, 400);
    }

    const input: CreateMailboxInput = { address, ownerEmail, displayName };
    let id: string;
    try {
      ({ id } = await createMailbox(c.env, input));
    } catch (err) {
      if (err instanceof MailboxExistsError) {
        return c.json({ error: "Address already exists." }, 409);
      }
      return c.json({ error: "Unable to create mailbox." }, 500);
    }

    // Best-effort welcome/activation email to the owner's login (Google) email.
    // The mailbox row is already committed, so a send failure must NEVER fail
    // the request — we only report whether the notice went out. loginUrl is the
    // origin of the admin's own request (the canonical Access-protected webmail
    // URL), so it needs no separate config.
    let welcomeEmailSent = false;
    try {
      await sendWelcomeEmail(c.env, {
        address,
        displayName,
        ownerEmail,
        loginUrl: new URL(c.req.url).origin,
      });
      welcomeEmailSent = true;
    } catch (err) {
      console.error("welcome email failed", err);
    }

    return c.json({ id, welcomeEmailSent }, 201);
  });

  app.delete("/admin/mailboxes/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const deleted = await deleteMailbox(c.env, id);
      if (!deleted) {
        return c.json({ error: "Mailbox not found." }, 404);
      }
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Unable to delete mailbox." }, 500);
    }
  });

  return app;
}
