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

  email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(handleInbound(message, env));
  },
} satisfies ExportedHandler<Env>;
