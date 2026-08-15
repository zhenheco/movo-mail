import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AccessEnv } from "../src/middleware/access";
import type { AccessUser, Env, Mailbox, SentItem } from "../src/types";

vi.mock("../src/db", () => ({
  getSentItems: vi.fn(),
  getSentItemsForUser: vi.fn(),
  getMailboxById: vi.fn(),
  getMailboxesForUser: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserRole: vi.fn(),
}));

import {
  getMailboxById,
  getMailboxesForUser,
  getSentItems,
  getSentItemsForUser,
  getUserByEmail,
  getUserRole,
} from "../src/db";
import { sentRoutes } from "../src/api/sent";

const mGetMailboxById = vi.mocked(getMailboxById);
const mGetMailboxesForUser = vi.mocked(getMailboxesForUser);
const mGetSentItems = vi.mocked(getSentItems);
const mGetSentItemsForUser = vi.mocked(getSentItemsForUser);
const mGetUserByEmail = vi.mocked(getUserByEmail);
const mGetUserRole = vi.mocked(getUserRole);

const USER: AccessUser = { sub: "access-alice", email: "alice@example.com" };
const DB_USER = {
  id: "db-alice",
  email: USER.email,
  name: null,
  role: "user" as const,
  created_at: 1,
  updated_at: 1,
};

const OWNED: Mailbox = {
  id: "mb-owned",
  address: "alice@movo.com.my",
  display_name: "Alice",
  owner_id: "db-alice",
  kind: "personal",
  created_at: 1,
  updated_at: 1,
};

const SHARED: Mailbox = {
  id: "mb-shared",
  address: "team@movo.com.my",
  display_name: "Team",
  owner_id: null,
  kind: "shared",
  created_at: 1,
  updated_at: 1,
};

const PERSONAL_OTHER: Mailbox = {
  ...OWNED,
  id: "mb-other",
  address: "other@movo.com.my",
  owner_id: "db-other",
};

const ITEMS: SentItem[] = [
  {
    kind: "sent",
    id: "message-1",
    mailboxId: OWNED.id,
    subject: "Hello",
    toAddresses: ["recipient@example.com"],
    snippet: "Hi",
    date: 1_700_000_000_000,
    status: "sent",
    error: null,
  },
  {
    kind: "failed",
    id: "log-1",
    mailboxId: OWNED.id,
    subject: "Failed",
    toAddresses: ["blocked@example.com"],
    snippet: null,
    date: 1_700_000_000_100,
    status: "failed",
    error: "relay unavailable",
  },
];

function fakeEnv(): Env {
  return {} as Env;
}

function makeApp(user: AccessUser = USER) {
  const app = new Hono<AccessEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", sentRoutes());
  return app;
}

function dispatch(path: string, user: AccessUser = USER) {
  return makeApp(user).request(path, undefined, fakeEnv());
}

beforeEach(() => {
  vi.clearAllMocks();
  mGetMailboxesForUser.mockResolvedValue([OWNED]);
  mGetMailboxById.mockResolvedValue(OWNED);
  mGetUserByEmail.mockResolvedValue(DB_USER);
  mGetUserRole.mockResolvedValue("user");
  mGetSentItems.mockResolvedValue(ITEMS);
  mGetSentItemsForUser.mockResolvedValue(ITEMS);
});

describe("GET /sent", () => {
  it("requires a mailbox query parameter", async () => {
    const res = await dispatch("/sent");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "mailbox is required" });
    expect(mGetSentItems).not.toHaveBeenCalled();
  });

  it("uses the viewer-scoped all-mailboxes query for mailbox=all", async () => {
    const res = await dispatch("/sent?mailbox=all");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: ITEMS });
    expect(mGetSentItemsForUser).toHaveBeenCalledWith(expect.anything(), {
      userId: DB_USER.id,
      isAdmin: false,
    });
    expect(mGetSentItems).not.toHaveBeenCalled();
    expect(mGetMailboxesForUser).not.toHaveBeenCalled();
  });

  it("loads an owned mailbox with the same resolved viewer", async () => {
    const res = await dispatch(`/sent?mailbox=${OWNED.id}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: ITEMS });
    expect(mGetSentItems).toHaveBeenCalledWith(expect.anything(), OWNED.id, {
      userId: DB_USER.id,
      isAdmin: false,
    });
  });

  it("allows a non-owner to read a shared mailbox", async () => {
    mGetMailboxesForUser.mockResolvedValue([]);
    mGetMailboxById.mockResolvedValue(SHARED);

    const res = await dispatch(`/sent?mailbox=${SHARED.id}`);

    expect(res.status).toBe(200);
    expect(mGetSentItems).toHaveBeenCalledWith(expect.anything(), SHARED.id, {
      userId: DB_USER.id,
      isAdmin: false,
    });
  });

  it("returns the same forbidden response for an unknown or private mailbox", async () => {
    mGetMailboxesForUser.mockResolvedValue([]);
    mGetMailboxById.mockResolvedValue(null);
    const missing = await dispatch("/sent?mailbox=does-not-exist");
    expect(missing.status).toBe(403);
    const missingBody = await missing.text();

    mGetMailboxById.mockResolvedValue(PERSONAL_OTHER);
    const privateRes = await dispatch(`/sent?mailbox=${PERSONAL_OTHER.id}`);
    expect(privateRes.status).toBe(403);
    expect(await privateRes.text()).toBe(missingBody);
    expect(mGetSentItems).not.toHaveBeenCalled();
  });

  it("returns a generic 500 when the sent query fails", async () => {
    mGetSentItemsForUser.mockRejectedValue(new Error("db details"));

    const res = await dispatch("/sent?mailbox=all");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "failed to load sent items" });
  });
});
