/**
 * Read-route tests for the api module.
 *
 * The db contract is fully mocked: these tests assert *route* behavior —
 * input validation, 404 on missing, HTML pass-through, and (critically) auth
 * scoping so one user can never read another mailbox's data.
 *
 * The middleware that sets `c.get('user')` is not exercised here; instead each
 * request is dispatched through a tiny harness app that injects a fixed user,
 * then mounts the real read router, so we test the handlers in isolation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { AccessEnv } from "../src/middleware/access";
import type { Env, AccessUser, Thread, Message, Mailbox } from "../src/types";
import type { MessageWithAttachments } from "../src/db";

// ── Mock the db contract ──────────────────────────────────────────────────
vi.mock("../src/db", () => ({
  getThreads: vi.fn(),
  getThreadsForOwner: vi.fn(),
  getMessage: vi.fn(),
  searchMessages: vi.fn(),
  searchMessagesForOwner: vi.fn(),
  getMailboxesForUser: vi.fn(),
}));

import {
  getThreads,
  getThreadsForOwner,
  getMessage,
  searchMessages,
  searchMessagesForOwner,
  getMailboxesForUser,
} from "../src/db";
import { readRoutes } from "../src/api/routes";

const mGetThreads = vi.mocked(getThreads);
const mGetThreadsForOwner = vi.mocked(getThreadsForOwner);
const mGetMessage = vi.mocked(getMessage);
const mSearchMessages = vi.mocked(searchMessages);
const mSearchMessagesForOwner = vi.mocked(searchMessagesForOwner);
const mGetMailboxesForUser = vi.mocked(getMailboxesForUser);

// ── Fixtures ──────────────────────────────────────────────────────────────
const USER: AccessUser = { sub: "u-sub-1", email: "alice@movo.com.my" };

const OWNED_MAILBOX: Mailbox = {
  id: "mb-alice",
  address: "alice@movo.com.my",
  display_name: "Alice",
  owner_id: "user-alice",
  created_at: 1,
  updated_at: 1,
};

function makeThread(over: Partial<Thread> = {}): Thread {
  return {
    id: "th-1",
    mailbox_id: "mb-alice",
    subject: "Hi",
    snippet: "hello",
    last_message_at: 100,
    last_message_id: "msg-1",
    message_count: 1,
    unread: 0,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

function makeMessage(
  over: Partial<MessageWithAttachments> = {},
): MessageWithAttachments {
  return {
    id: "msg-1",
    thread_id: "th-1",
    mailbox_id: "mb-alice",
    message_id: "<a@x>",
    in_reply_to: null,
    references: null,
    direction: "inbound",
    from_address: "bob@example.com",
    from_name: "Bob",
    to_addresses: JSON.stringify(["alice@movo.com.my"]),
    cc_addresses: null,
    bcc_addresses: null,
    subject: "Hi",
    snippet: "hello",
    text_body: "hello",
    html_body: "<p>hello</p>",
    r2_raw_key: null,
    has_attachments: 0,
    unread: 0,
    date: 100,
    created_at: 1,
    attachments: [],
    ...over,
  };
}

/** A minimal fake R2 bucket whose `get` returns null unless overridden. */
function fakeEnv(over: Partial<Env> = {}): Env {
  const base = {
    MAIL_R2: { get: vi.fn().mockResolvedValue(null) },
  } as unknown as Env;
  return { ...base, ...over };
}

/**
 * Mount the read router behind a stub that injects a fixed user. The Worker env
 * is supplied through Hono's third `.request()` argument (see `dispatch`).
 */
function makeApp() {
  const app = new Hono<AccessEnv>();
  app.use("*", async (c, next) => {
    c.set("user", USER);
    await next();
  });
  app.route("/", readRoutes());
  return app;
}

/** Dispatch a GET through the app with a concrete env bound to the context. */
function dispatch(path: string, env: Env = fakeEnv()) {
  return makeApp().request(path, undefined, env);
}

beforeEach(() => {
  vi.clearAllMocks();
  // By default the user owns OWNED_MAILBOX.
  mGetMailboxesForUser.mockResolvedValue([OWNED_MAILBOX]);
});

// ── GET /threads ────────────────────────────────────────────────────────
describe("GET /threads", () => {
  it("400 when mailbox is missing", async () => {
    const res = await dispatch("/threads");
    expect(res.status).toBe(400);
  });

  it("returns threads for an owned mailbox", async () => {
    mGetThreads.mockResolvedValue([makeThread()]);
    const res = await dispatch("/threads?mailbox=mb-alice");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: Thread[] };
    expect(body.threads).toHaveLength(1);
    // The UI opens last_message_id, so the route must pass it through verbatim.
    expect(body.threads[0]?.last_message_id).toBe("msg-1");
    expect(mGetThreads).toHaveBeenCalledWith(expect.anything(), "mb-alice");
  });

  it("403 when the user does not own the requested mailbox", async () => {
    const res = await dispatch("/threads?mailbox=mb-eve");
    expect(res.status).toBe(403);
    expect(mGetThreads).not.toHaveBeenCalled();
  });

  it("500 when db throws", async () => {
    mGetThreads.mockRejectedValue(new Error("db down"));
    const res = await dispatch("/threads?mailbox=mb-alice");
    expect(res.status).toBe(500);
  });
});

// ── GET /threads/all (unified inbox) ──────────────────────────────────────
describe("GET /threads/all", () => {
  it("returns merged threads across owned mailboxes (no mailbox param needed)", async () => {
    mGetThreadsForOwner.mockResolvedValue([
      makeThread({ id: "th-1", mailbox_id: "mb-alice" }),
      makeThread({ id: "th-2", mailbox_id: "mb-team" }),
    ]);
    const res = await dispatch("/threads/all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: Thread[] };
    expect(body.threads.map((t) => t.id)).toEqual(["th-1", "th-2"]);
    // Scoped by the verified email, not a client-supplied mailbox.
    expect(mGetThreadsForOwner).toHaveBeenCalledWith(
      expect.anything(),
      USER.email,
    );
    // The per-mailbox path must NOT be used for the unified view.
    expect(mGetThreads).not.toHaveBeenCalled();
  });

  it("500 when db throws", async () => {
    mGetThreadsForOwner.mockRejectedValue(new Error("db down"));
    const res = await dispatch("/threads/all");
    expect(res.status).toBe(500);
  });
});

// ── GET /message/:id ──────────────────────────────────────────────────────
describe("GET /message/:id", () => {
  it("404 when the message does not exist", async () => {
    mGetMessage.mockResolvedValue(null);
    const res = await dispatch("/message/nope");
    expect(res.status).toBe(404);
  });

  it("404 (not 403) when the message belongs to another mailbox", async () => {
    mGetMessage.mockResolvedValue(makeMessage({ mailbox_id: "mb-eve" }));
    const res = await dispatch("/message/msg-1");
    expect(res.status).toBe(404);
  });

  it("returns the message with html_body unchanged", async () => {
    const rawHtml = '<p onclick="evil()">hi</p><script>steal()</script>';
    mGetMessage.mockResolvedValue(
      makeMessage({
        html_body: rawHtml,
      }),
    );
    const res = await dispatch("/message/msg-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: MessageWithAttachments };
    expect(body.message.html_body).toBe(rawHtml);
  });

  it("does not treat the R2 raw .eml as html_body when html_body is null", async () => {
    mGetMessage.mockResolvedValue(
      makeMessage({ html_body: null, r2_raw_key: "msg/msg-1.eml" }),
    );
    const r2Get = vi.fn().mockResolvedValue({
      text: () => Promise.resolve("<b>raw</b><script>x()</script>"),
    });
    const env = fakeEnv({
      MAIL_R2: { get: r2Get } as unknown as Env["MAIL_R2"],
    });
    const res = await dispatch("/message/msg-1", env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: MessageWithAttachments };
    expect(body.message.html_body).toBeNull();
    expect(r2Get).not.toHaveBeenCalled();
  });

  it("500 when db throws", async () => {
    mGetMessage.mockRejectedValue(new Error("db down"));
    const res = await dispatch("/message/msg-1");
    expect(res.status).toBe(500);
  });
});

// ── GET /search ───────────────────────────────────────────────────────────
describe("GET /search", () => {
  it("400 when q is missing", async () => {
    const res = await dispatch("/search");
    expect(res.status).toBe(400);
  });

  it("400 when q is blank", async () => {
    const res = await dispatch("/search?q=%20%20");
    expect(res.status).toBe(400);
  });

  it("scopes to a requested owned mailbox", async () => {
    mSearchMessages.mockResolvedValue([
      makeMessage({ mailbox_id: "mb-alice" }) as Message,
    ]);
    const res = await dispatch("/search?q=hi&mailbox=mb-alice");
    expect(res.status).toBe(200);
    expect(mSearchMessages).toHaveBeenCalledWith(
      expect.anything(),
      "hi",
      "mb-alice",
    );
  });

  it("403 when searching a non-owned mailbox", async () => {
    const res = await dispatch("/search?q=hi&mailbox=mb-eve");
    expect(res.status).toBe(403);
    expect(mSearchMessages).not.toHaveBeenCalled();
  });

  it("uses owner-scoped SQL search (scoped before LIMIT) when no mailbox given", async () => {
    // The route must NOT do a global search + JS filter (that lets other users'
    // matches crowd out the caller's hits and materializes cross-user rows).
    mSearchMessagesForOwner.mockResolvedValue([
      makeMessage({ id: "ok", mailbox_id: "mb-alice" }) as Message,
    ]);
    const res = await dispatch("/search?q=hi");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Message[] };
    expect(body.results.map((m) => m.id)).toEqual(["ok"]);
    expect(mSearchMessagesForOwner).toHaveBeenCalledWith(
      expect.anything(),
      "hi",
      USER.email,
    );
    expect(mSearchMessages).not.toHaveBeenCalled();
  });

  it("500 when db throws", async () => {
    mSearchMessages.mockRejectedValue(new Error("db down"));
    const res = await dispatch("/search?q=hi&mailbox=mb-alice");
    expect(res.status).toBe(500);
  });
});
