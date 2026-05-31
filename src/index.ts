/**
 * Movo Mail — Worker entrypoint.
 *
 * Exports:
 *   fetch  — Hono app: Access-guarded /api/* + SPA fallback to env.ASSETS
 *   email  — inbound Email Worker handler (delegates to handleInbound)
 */

import { Hono } from "hono";
import type { Env } from "./types";
import type { AccessEnv } from "./middleware/access";
import { accessAuth } from "./middleware/access";
import { apiRoutes } from "./api/routes";
import { handleInbound } from "./email/inbound";
import { isManagedAddress } from "./db";

const app = new Hono<AccessEnv>();

// Lightweight unauthenticated health check.
app.get("/healthz", (c) => c.json({ ok: true }));

// All /api/* routes require a valid Cloudflare Access JWT.
app.use("/api/*", accessAuth());
app.route("/api", apiRoutes());

// SPA fallback: serve static assets for everything else.
app.all("*", async (c) => {
  try {
    return await c.env.ASSETS.fetch(c.req.raw);
  } catch {
    return c.text("Asset unavailable", 502);
  }
});

export default {
  fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  /**
   * Inbound Email Worker handler — the catch-all → worker SPLIT.
   *
   * CF Email Routing's catch-all is repointed at this handler, so every address
   * on the domain arrives here. We classify the recipient and either STORE or
   * FORWARD it:
   *   - recipient IS a managed mailbox (a row in D1 `mailboxes`) → store it via
   *     handleInbound (run on waitUntil so the runtime can ack promptly).
   *   - recipient is NOT managed → forward to env.FALLBACK_FORWARD, preserving
   *     the prior catch-all → acejou27 behavior. A non-managed message must
   *     NEVER be silently dropped.
   *
   * Note: higher-priority CF Email Routing rules (e.g. priss@ / kee@) forward
   * those addresses upstream, so they never reach this catch-all handler.
   *
   * Resilience: an isManagedAddress() failure is treated as NON-managed (we
   * forward rather than risk dropping). A forward() rejection is caught and
   * logged — we deliberately do not rethrow here, since the message has already
   * been classified as non-storable and re-running email() would re-forward.
   */
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Default to NON-managed on classification failure: forwarding is safe
    // (never drops), whereas treating an unknown as managed would lose the mail.
    const managed = await isManagedAddress(env, message.to).catch(() => false);

    if (managed) {
      // Store path — unchanged. handleInbound never throws (logs + swallows).
      ctx.waitUntil(handleInbound(message, env));
      return;
    }

    // Forward path — preserve catch-all behavior; never drop non-managed mail.
    try {
      await message.forward(env.FALLBACK_FORWARD);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[email] failed to forward non-managed mail for ${message.to} ` +
          `to ${env.FALLBACK_FORWARD}: ${reason}`,
      );
    }
  },
} satisfies ExportedHandler<Env>;
