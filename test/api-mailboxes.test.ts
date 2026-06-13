/**
 * Route tests for the mailbox-listing surface (src/api/mailboxes.ts).
 *
 *   GET /mailboxes → { mailboxes: { id, address, displayName }[] }
 *
 * The db contract is fully mocked. These tests assert that the caller only ever
 * sees the mailboxes returned by `getMailboxesForUser(env, user.email)` — i.e.
 * the listing is scoped to the authenticated identity (different users see
 * different sets), the row shape is mapped to the API shape, and db failures
 * surface as a clean 500 with a friendly error.
 *
 * Mirrors the harness style of test/api-read.test.ts: mock ../src/db, mount the
 * real router behind a stub middleware that injects a fixed user, and dispatch.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { AccessEnv } from "../src/middleware/access";
import type { Env, AccessUser, Mailbox } from "../src/types";

// ── Mock the db contract ──────────────────────────────────────────────────
vi.mock("../src/db", () => ({
  getMailboxesForUser: vi.fn(),
  getSendableMailboxes: vi.fn(),
}));

import { getMailboxesForUser, getSendableMailboxes } from "../src/db";
import { mailboxRoutes } from "../src/api/mailboxes";

const mGetMailboxesForUser = vi.mocked(getMailboxesForUser);
const mGetSendableMailboxes = vi.mocked(getSendableMailboxes);

// ── Fixtures ──────────────────────────────────────────────────────────────
const ALICE: AccessUser = { sub: "u-alice", email: "alice@movo.com.my" };
const BOB: AccessUser = { sub: "u-bob", email: "bob@movo.com.my" };

function makeMailbox(over: Partial<Mailbox> = {}): Mailbox {
  return {
    id: "mb-alice",
    address: "alice@movo.com.my",
    display_name: "Alice",
    owner_id: "user-alice",
    kind: "personal",
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

function fakeEnv(over: Partial<Env> = {}): Env {
  return { ...({} as unknown as Env), ...over };
}

/** Mount the mailbox router behind a stub that injects a fixed user. */
function makeApp(user: AccessUser) {
  const app = new Hono<AccessEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", mailboxRoutes());
  return app;
}

function dispatch(user: AccessUser, env: Env = fakeEnv()) {
  return makeApp(user).request("/mailboxes", undefined, env);
}

function dispatchSendable(user: AccessUser, env: Env = fakeEnv()) {
  return makeApp(user).request("/mailboxes/sendable", undefined, env);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /mailboxes", () => {
  it("returns the caller's mailboxes mapped to { id, address, displayName, kind }", async () => {
    mGetMailboxesForUser.mockResolvedValue([makeMailbox()]);
    const res = await dispatch(ALICE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mailboxes: {
        id: string;
        address: string;
        displayName: string | null;
        kind: string;
      }[];
    };
    expect(body.mailboxes).toEqual([
      {
        id: "mb-alice",
        address: "alice@movo.com.my",
        displayName: "Alice",
        kind: "personal",
      },
    ]);
    expect(mGetMailboxesForUser).toHaveBeenCalledWith(
      expect.anything(),
      "alice@movo.com.my",
    );
  });

  it("maps a null display_name to displayName: null", async () => {
    mGetMailboxesForUser.mockResolvedValue([
      makeMailbox({ display_name: null }),
    ]);
    const res = await dispatch(ALICE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mailboxes: { displayName: string | null }[];
    };
    expect(body.mailboxes[0]?.displayName).toBeNull();
  });

  it("scopes the listing to the authenticated user (a user sees only their own)", async () => {
    // Each user resolves to a disjoint mailbox set based on their email.
    mGetMailboxesForUser.mockImplementation(async (_env, email) => {
      if (email === "alice@movo.com.my") {
        return [makeMailbox({ id: "mb-alice", address: "alice@movo.com.my" })];
      }
      if (email === "bob@movo.com.my") {
        return [makeMailbox({ id: "mb-bob", address: "bob@movo.com.my" })];
      }
      return [];
    });

    const aliceRes = await dispatch(ALICE);
    const aliceBody = (await aliceRes.json()) as {
      mailboxes: { id: string }[];
    };
    expect(aliceBody.mailboxes.map((m) => m.id)).toEqual(["mb-alice"]);

    const bobRes = await dispatch(BOB);
    const bobBody = (await bobRes.json()) as { mailboxes: { id: string }[] };
    expect(bobBody.mailboxes.map((m) => m.id)).toEqual(["mb-bob"]);
  });

  it("returns an empty list when the user owns no mailboxes", async () => {
    mGetMailboxesForUser.mockResolvedValue([]);
    const res = await dispatch(ALICE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mailboxes: unknown[] };
    expect(body.mailboxes).toEqual([]);
  });

  it("returns 500 with a friendly error when the db throws", async () => {
    mGetMailboxesForUser.mockRejectedValue(new Error("db down"));
    const res = await dispatch(ALICE);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unable to load mailboxes.");
  });
});

describe("GET /mailboxes/sendable", () => {
  it("returns sendable mailboxes mapped to { id, address, displayName, kind }", async () => {
    mGetSendableMailboxes.mockResolvedValue([
      makeMailbox(),
      makeMailbox({
        id: "mb-shared",
        address: "hello@movo.com.my",
        display_name: "Hello",
        owner_id: null,
        kind: "shared",
      }),
    ]);

    const res = await dispatchSendable(ALICE);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mailboxes: {
        id: string;
        address: string;
        displayName: string | null;
        kind: string;
      }[];
    };
    expect(body.mailboxes).toEqual([
      {
        id: "mb-alice",
        address: "alice@movo.com.my",
        displayName: "Alice",
        kind: "personal",
      },
      {
        id: "mb-shared",
        address: "hello@movo.com.my",
        displayName: "Hello",
        kind: "shared",
      },
    ]);
    expect(mGetSendableMailboxes).toHaveBeenCalledWith(
      expect.anything(),
      ALICE,
    );
    expect(mGetMailboxesForUser).not.toHaveBeenCalled();
  });

  it("returns 500 with a friendly error when the sendable lookup fails", async () => {
    mGetSendableMailboxes.mockRejectedValue(new Error("db down"));

    const res = await dispatchSendable(ALICE);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unable to load sendable mailboxes.");
  });
});
