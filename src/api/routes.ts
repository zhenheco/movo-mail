/**
 * HTTP API router — READ surface.
 *
 * Mounted under /api in src/index.ts behind the Access middleware. This file is
 * owned by the `api` module and composes ONLY the read sub-routers
 * (threads / message / search), each defined in its own focused file.
 *
 * The send (`POST /send`, `GET /status/:id`) and AI (`POST /ai/draft`) surfaces
 * are owned by their own module agents (src/api/send.ts, src/api/ai.ts) and
 * export their own routers; the integrate step mounts them alongside the read
 * router returned here. This keeps each module independently type-checkable.
 *
 * Read routes (all scoped to the authenticated user's mailboxes — see
 * src/api/scope.ts; a user can never read another mailbox's data):
 *   GET /mailboxes              → { mailboxes: { id, address, displayName }[] }
 *   GET /threads   ?mailbox=    → { threads: Thread[] }
 *   GET /message/:id            → { message: MessageWithAttachments } (sanitized HTML)
 *   GET /search    ?q=&mailbox= → { results: Message[] }
 */

import { Hono } from "hono";
import type { AccessEnv } from "../middleware/access";
import { mailboxRoutes } from "./mailboxes";
import { threadRoutes } from "./threads";
import { messageRoutes } from "./message";
import { searchRoutes } from "./search";
import { sendRoutes } from "./send";
import { aiRoutes } from "./ai";
import { meRoutes } from "./me";
import { adminRoutes } from "./admin";

// Re-exported so the integrate step / tests can mount or exercise the identity
// and admin surfaces independently of the read/send/AI surfaces.
export { meRoutes, adminRoutes };

/**
 * Build the read-route sub-router (threads + message + search). Exported so the
 * integrate step / tests can mount or exercise the read surface independently of
 * the send/AI surfaces owned by other module agents.
 */
export function readRoutes(): Hono<AccessEnv> {
  const app = new Hono<AccessEnv>();
  app.route("/", mailboxRoutes());
  app.route("/", threadRoutes());
  app.route("/", messageRoutes());
  app.route("/", searchRoutes());
  return app;
}

/**
 * Build the API router mounted by src/index.ts. Carries the full /api surface:
 * the read routes (threads / message / search), the send surface owned by
 * src/api/send.ts, and the AI draft surface owned by src/api/ai.ts. All run
 * under the Access middleware applied in src/index.ts.
 */
export function apiRoutes(): Hono<AccessEnv> {
  const app = new Hono<AccessEnv>();
  app.route("/", readRoutes());
  app.route("/", sendRoutes());
  app.route("/", aiRoutes());
  app.route("/", meRoutes());
  app.route("/", adminRoutes());
  return app;
}
