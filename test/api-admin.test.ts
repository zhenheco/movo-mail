/**
 * Admin + identity route tests for the api module.
 *
 * The db contract is fully mocked (mirrors test/api-read.test.ts): these tests
 * assert *route* behavior — the admin authorization guard (a non-admin must be
 * Forbidden BEFORE any work), input validation (address must be @movo.com.my,
 * ownerEmail must be an email), conflict/not-found mapping, and that GET /me
 * reports isAdmin correctly.
 *
 * The Access middleware that sets `c.get('user')` is not exercised here; each
 * request is dispatched through a tiny harness app that injects a fixed user,
 * then mounts the real me + admin routers, so the handlers are tested in
 * isolation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { AccessEnv } from "../src/middleware/access";
import type { Env, AccessUser, AdminMailbox } from "../src/types";

// ── Mock the db contract ──────────────────────────────────────────────────
vi.mock("../src/db", () => ({
  getUserRole: vi.fn(),
  listAllMailboxes: vi.fn(),
  createMailbox: vi.fn(),
  deleteMailbox: vi.fn(),
  // Re-export the typed conflict error so admin.ts can `instanceof` it. A tiny
  // local subclass keeps the contract without importing the real module.
  MailboxExistsError: class MailboxExistsError extends Error {
    constructor(public readonly address: string) {
      super(`mailbox already exists: ${address}`);
      this.name = "MailboxExistsError";
    }
  },
}));

// The welcome email is a separate, best-effort concern — mock it so the route
// tests assert only that it is invoked with the right inputs and that a send
// failure never blocks the (already-committed) mailbox creation.
vi.mock("../src/lib/welcome", () => ({
  sendWelcomeEmail: vi.fn(),
}));

import {
  getUserRole,
  listAllMailboxes,
  createMailbox,
  deleteMailbox,
  MailboxExistsError,
} from "../src/db";
import { sendWelcomeEmail } from "../src/lib/welcome";
import { meRoutes, adminRoutes } from "../src/api/routes";

const mGetUserRole = vi.mocked(getUserRole);
const mListAllMailboxes = vi.mocked(listAllMailboxes);
const mCreateMailbox = vi.mocked(createMailbox);
const mDeleteMailbox = vi.mocked(deleteMailbox);
const mSendWelcome = vi.mocked(sendWelcomeEmail);

// ── Fixtures ──────────────────────────────────────────────────────────────
const ADMIN: AccessUser = { sub: "u-admin", email: "boss@movo.com.my" };
const NORMAL: AccessUser = { sub: "u-user", email: "alice@movo.com.my" };

function makeAdminMailbox(over: Partial<AdminMailbox> = {}): AdminMailbox {
  return {
    id: "mb-1",
    address: "ops@movo.com.my",
    displayName: "Ops",
    ownerEmail: "ops@movo.com.my",
    ...over,
  };
}

/** A minimal fake env; db is mocked so no real bindings are touched. */
function fakeEnv(over: Partial<Env> = {}): Env {
  return { ...({} as Env), ...over };
}

/**
 * Mount the me + admin routers behind a stub that injects a fixed user. The
 * Worker env is supplied through Hono's third `.request()` argument.
 */
function makeApp(user: AccessUser) {
  const app = new Hono<AccessEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", meRoutes());
  app.route("/", adminRoutes());
  return app;
}

function dispatch(
  user: AccessUser,
  path: string,
  init?: RequestInit,
  env: Env = fakeEnv(),
) {
  return makeApp(user).request(path, init, env);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── GET /me ─────────────────────────────────────────────────────────────────
describe("GET /me", () => {
  it("returns isAdmin: true for an admin", async () => {
    mGetUserRole.mockResolvedValue("admin");
    const res = await dispatch(ADMIN, "/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; isAdmin: boolean };
    expect(body.email).toBe(ADMIN.email);
    expect(body.isAdmin).toBe(true);
  });

  it("returns isAdmin: false for a non-admin", async () => {
    mGetUserRole.mockResolvedValue("user");
    const res = await dispatch(NORMAL, "/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; isAdmin: boolean };
    expect(body.email).toBe(NORMAL.email);
    expect(body.isAdmin).toBe(false);
  });

  it("returns isAdmin: false for an unknown role (null)", async () => {
    mGetUserRole.mockResolvedValue(null);
    const res = await dispatch(NORMAL, "/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isAdmin: boolean };
    expect(body.isAdmin).toBe(false);
  });

  it("500 when db throws", async () => {
    mGetUserRole.mockRejectedValue(new Error("db down"));
    const res = await dispatch(NORMAL, "/me");
    expect(res.status).toBe(500);
  });
});

// ── Admin authorization guard ────────────────────────────────────────────────
describe("admin guard (non-admin → 403 before any work)", () => {
  beforeEach(() => {
    mGetUserRole.mockResolvedValue("user");
  });

  it("403 on GET /admin/mailboxes", async () => {
    const res = await dispatch(NORMAL, "/admin/mailboxes");
    expect(res.status).toBe(403);
    expect(mListAllMailboxes).not.toHaveBeenCalled();
  });

  it("403 on POST /admin/mailboxes", async () => {
    const res = await dispatch(NORMAL, "/admin/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: "new@movo.com.my",
        ownerEmail: "new@movo.com.my",
      }),
    });
    expect(res.status).toBe(403);
    expect(mCreateMailbox).not.toHaveBeenCalled();
  });

  it("403 on DELETE /admin/mailboxes/:id", async () => {
    const res = await dispatch(NORMAL, "/admin/mailboxes/mb-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
    expect(mDeleteMailbox).not.toHaveBeenCalled();
  });

  it("403 for an unknown role (null)", async () => {
    mGetUserRole.mockResolvedValue(null);
    const res = await dispatch(NORMAL, "/admin/mailboxes");
    expect(res.status).toBe(403);
    expect(mListAllMailboxes).not.toHaveBeenCalled();
  });
});

// ── GET /admin/mailboxes ─────────────────────────────────────────────────────
describe("GET /admin/mailboxes (admin)", () => {
  beforeEach(() => {
    mGetUserRole.mockResolvedValue("admin");
  });

  it("lists all mailboxes", async () => {
    mListAllMailboxes.mockResolvedValue([
      makeAdminMailbox({ id: "mb-1" }),
      makeAdminMailbox({ id: "mb-2", address: "sales@movo.com.my" }),
    ]);
    const res = await dispatch(ADMIN, "/admin/mailboxes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mailboxes: AdminMailbox[] };
    expect(body.mailboxes).toHaveLength(2);
    expect(mListAllMailboxes).toHaveBeenCalledTimes(1);
  });

  it("500 when db throws", async () => {
    mListAllMailboxes.mockRejectedValue(new Error("db down"));
    const res = await dispatch(ADMIN, "/admin/mailboxes");
    expect(res.status).toBe(500);
  });
});

// ── POST /admin/mailboxes ────────────────────────────────────────────────────
describe("POST /admin/mailboxes (admin)", () => {
  beforeEach(() => {
    mGetUserRole.mockResolvedValue("admin");
  });

  it("201 with the new id on success", async () => {
    mCreateMailbox.mockResolvedValue({ id: "mb-new" });
    const res = await dispatch(ADMIN, "/admin/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: "new@movo.com.my",
        ownerEmail: "owner@movo.com.my",
        displayName: "New Box",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("mb-new");
    expect(mCreateMailbox).toHaveBeenCalledWith(expect.anything(), {
      address: "new@movo.com.my",
      ownerEmail: "owner@movo.com.my",
      displayName: "New Box",
    });
  });

  it("sends a welcome email to the owner and reports welcomeEmailSent: true", async () => {
    mCreateMailbox.mockResolvedValue({ id: "mb-new" });
    mSendWelcome.mockResolvedValue(undefined);
    const res = await dispatch(ADMIN, "/admin/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: "new@movo.com.my",
        ownerEmail: "owner@gmail.com",
        displayName: "New Box",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; welcomeEmailSent: boolean };
    expect(body.id).toBe("mb-new");
    expect(body.welcomeEmailSent).toBe(true);
    // Recipient is the owner login email; loginUrl is derived from the request
    // origin (http://localhost under the Hono test harness).
    expect(mSendWelcome).toHaveBeenCalledWith(expect.anything(), {
      address: "new@movo.com.my",
      ownerEmail: "owner@gmail.com",
      displayName: "New Box",
      loginUrl: "http://localhost",
    });
  });

  it("still returns 201 with welcomeEmailSent: false when the welcome email fails", async () => {
    mCreateMailbox.mockResolvedValue({ id: "mb-new" });
    mSendWelcome.mockRejectedValue(new Error("relay down"));
    const res = await dispatch(ADMIN, "/admin/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: "new@movo.com.my",
        ownerEmail: "owner@gmail.com",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; welcomeEmailSent: boolean };
    expect(body.id).toBe("mb-new");
    expect(body.welcomeEmailSent).toBe(false);
  });

  it("400 when the address is not @movo.com.my", async () => {
    const res = await dispatch(ADMIN, "/admin/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: "evil@gmail.com",
        ownerEmail: "owner@movo.com.my",
      }),
    });
    expect(res.status).toBe(400);
    expect(mCreateMailbox).not.toHaveBeenCalled();
  });

  it("400 when the address is malformed", async () => {
    const res = await dispatch(ADMIN, "/admin/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: "not-an-address",
        ownerEmail: "owner@movo.com.my",
      }),
    });
    expect(res.status).toBe(400);
    expect(mCreateMailbox).not.toHaveBeenCalled();
  });

  it("400 when ownerEmail is not a valid email", async () => {
    const res = await dispatch(ADMIN, "/admin/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: "ok@movo.com.my",
        ownerEmail: "nope",
      }),
    });
    expect(res.status).toBe(400);
    expect(mCreateMailbox).not.toHaveBeenCalled();
  });

  it("400 when the body is not valid JSON", async () => {
    const res = await dispatch(ADMIN, "/admin/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(mCreateMailbox).not.toHaveBeenCalled();
  });

  it("409 when the address already exists", async () => {
    mCreateMailbox.mockRejectedValue(
      new MailboxExistsError("dup@movo.com.my"),
    );
    const res = await dispatch(ADMIN, "/admin/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: "dup@movo.com.my",
        ownerEmail: "owner@movo.com.my",
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Address already exists.");
  });

  it("500 when db throws an unexpected error", async () => {
    mCreateMailbox.mockRejectedValue(new Error("db down"));
    const res = await dispatch(ADMIN, "/admin/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: "ok@movo.com.my",
        ownerEmail: "owner@movo.com.my",
      }),
    });
    expect(res.status).toBe(500);
  });
});

// ── DELETE /admin/mailboxes/:id ──────────────────────────────────────────────
describe("DELETE /admin/mailboxes/:id (admin)", () => {
  beforeEach(() => {
    mGetUserRole.mockResolvedValue("admin");
  });

  it("200 { ok: true } when the mailbox is deleted", async () => {
    mDeleteMailbox.mockResolvedValue(true);
    const res = await dispatch(ADMIN, "/admin/mailboxes/mb-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mDeleteMailbox).toHaveBeenCalledWith(expect.anything(), "mb-1");
  });

  it("404 when the mailbox does not exist", async () => {
    mDeleteMailbox.mockResolvedValue(false);
    const res = await dispatch(ADMIN, "/admin/mailboxes/nope", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("500 when db throws", async () => {
    mDeleteMailbox.mockRejectedValue(new Error("db down"));
    const res = await dispatch(ADMIN, "/admin/mailboxes/mb-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(500);
  });
});
