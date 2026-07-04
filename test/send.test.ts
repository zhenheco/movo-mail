/**
 * Tests for module: send
 *   - src/lib/cfemail.ts  (sendViaCfEmail transport)
 *   - src/api/send.ts     (sendRoutes(): POST /send handler)
 *
 * The cf-email relay (global fetch) and the DB layer (../src/db) are mocked.
 * We assert:
 *   1. from is enforced to the authenticated user's mailbox address
 *   2. In-Reply-To / References are derived from the thread being replied to
 *   3. an idempotencyKey is always present on the relay request
 *   4. a send_log row is written on success
 *   5. a suppressed/blocked relay status surfaces a 4xx and logs a failed send
 *
 * Signatures mirror the real db contract exactly:
 *   getThread(env, id)             -> ThreadWithMessages | null
 *   getSendableMailboxes(env, user) -> Mailbox[]
 *   insertOutboundMessage(env, m)  -> Promise<string>
 *   insertSendLog(env, input)      -> Promise<string>
 *   insertAudit(env, input)        -> Promise<string>
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

import type { AccessEnv } from "../src/middleware/access";
import type { Env, AccessUser, Mailbox, SendRequest, SendResult } from "../src/types";

// ── mock the db contract (env-first signatures, matching src/db/index.ts) ─────
const getThread = vi.fn((..._args: unknown[]): unknown => null);
const getMailboxesForUser = vi.fn((..._args: unknown[]): unknown => []);
const getSendableMailboxes = vi.fn((..._args: unknown[]): unknown => []);
const getUserByEmail = vi.fn((..._args: unknown[]): unknown => null);
const claimThread = vi.fn(async (..._args: unknown[]): Promise<boolean> => false);
const insertOutboundMessage = vi.fn(async (..._args: unknown[]): Promise<string> => "msg-row-1");
const insertSendLog = vi.fn(async (..._args: unknown[]): Promise<string> => "send-log-1");
const insertAudit = vi.fn(async (..._args: unknown[]): Promise<string> => "audit-1");

vi.mock("../src/db", () => ({
  getThread: (...a: unknown[]) => getThread(...a),
  getMailboxesForUser: (...a: unknown[]) => getMailboxesForUser(...a),
  getSendableMailboxes: (...a: unknown[]) => getSendableMailboxes(...a),
  getUserByEmail: (...a: unknown[]) => getUserByEmail(...a),
  claimThread: (...a: unknown[]) => claimThread(...a),
  insertOutboundMessage: (...a: unknown[]) => insertOutboundMessage(...a),
  insertSendLog: (...a: unknown[]) => insertSendLog(...a),
  insertAudit: (...a: unknown[]) => insertAudit(...a),
}));

// imported AFTER vi.mock so the route picks up the mocked db
const { sendRoutes } = await import("../src/api/send");
import { sendViaCfEmail } from "../src/lib/cfemail";

// ── fixtures ──────────────────────────────────────────────────────────────
const USER: AccessUser = {
  sub: "usr_nelson",
  email: "nelson@gmail.com",
  name: "Nelson",
};

const MAILBOX: Mailbox = {
  id: "mbx_sales",
  address: "sales@movo.com.my",
  display_name: "Sales",
  owner_id: "usr_nelson",
  kind: "personal",
  created_at: 0,
  updated_at: 0,
};

const SHARED_MAILBOX: Mailbox = {
  id: "mbx_hello",
  address: "hello@movo.com.my",
  display_name: "Hello",
  owner_id: null,
  kind: "shared",
  created_at: 0,
  updated_at: 0,
};

/** A ThreadWithMessages-shaped reply target (one inbound message). */
function threadWith(
  messageId: string,
  references: string | null,
  mailboxId: string = MAILBOX.id,
) {
  return {
    id: "thr_1",
    mailbox_id: mailboxId,
    subject: "Order #1",
    snippet: "hi",
    assignee_id: null,
    last_message_at: 100,
    message_count: 1,
    unread: 0,
    created_at: 1,
    updated_at: 1,
    messages: [
      {
        id: "m1",
        thread_id: "thr_1",
        mailbox_id: mailboxId,
        message_id: messageId,
        in_reply_to: null,
        references,
        direction: "inbound",
        from_address: "bob@example.com",
        from_name: "Bob",
        to_addresses: JSON.stringify(["sales@movo.com.my"]),
        cc_addresses: null,
        bcc_addresses: null,
        subject: "Order #1",
        snippet: "hi",
        text_body: "hi",
        html_body: null,
        r2_raw_key: null,
        has_attachments: 0,
        unread: 0,
        date: 100,
        created_at: 1,
        attachments: [],
      },
    ],
  };
}

/** A minimal in-memory KV that honours get/put (the bits the route uses). */
function memKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
  } as unknown as KVNamespace;
}

/** A minimal Env. `kv` lets a test supply a working KV (rate-limit/idempotency). */
function makeEnv(kv?: KVNamespace): Env {
  return {
    DB: {} as unknown as D1Database,
    MAIL_R2: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
    MAIL_KV: kv ?? memKv(),
    ASSETS: {} as unknown as Fetcher,
    CF_EMAIL_ENDPOINT: "https://cf-email.example.workers.dev",
    CF_EMAIL_API_KEY: "cfes_test_key",
    CF_ACCESS_AUD: "aud",
    CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    AI_API_KEY: "ai_test_key",
    FALLBACK_FORWARD: "fallback@movo.com.my",
  };
}

/** Mount sendRoutes() behind a middleware that injects the authenticated user. */
function makeApp(): Hono<AccessEnv> {
  const app = new Hono<AccessEnv>();
  app.use("*", async (c, next) => {
    c.set("user", USER);
    await next();
  });
  app.route("/", sendRoutes());
  return app;
}

/** A typed fetch mock; stubs global fetch and returns the same mock for reads. */
function stubRelay(
  responder: () => Response,
): ReturnType<typeof vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>> {
  const mock = vi.fn(async (_input: unknown, _init?: RequestInit) => responder());
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Read the JSON body sent on the n-th relay call. */
function sentBody(
  mock: ReturnType<typeof stubRelay>,
  n = 0,
): Record<string, unknown> {
  const call = mock.mock.calls[n];
  if (!call) throw new Error(`no relay call at index ${n}`);
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
}

const relayOk = (status = "sent") => (): Response =>
  new Response(JSON.stringify({ id: "cfes_msg_1", status }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function postBody(body: unknown): Request {
  return new Request("http://localhost/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  getThread.mockReset();
  getMailboxesForUser.mockReset();
  getSendableMailboxes.mockReset();
  getUserByEmail.mockReset();
  claimThread.mockReset();
  insertOutboundMessage.mockClear();
  insertSendLog.mockClear();
  insertAudit.mockClear();
  insertOutboundMessage.mockResolvedValue("msg-row-1");
  insertSendLog.mockResolvedValue("send-log-1");
  insertAudit.mockResolvedValue("audit-1");
  getThread.mockResolvedValue(null);
  getMailboxesForUser.mockResolvedValue([MAILBOX]);
  getSendableMailboxes.mockResolvedValue([MAILBOX]);
  getUserByEmail.mockResolvedValue({
    id: "db-user-nelson",
    email: USER.email,
    name: USER.name ?? null,
    role: "user",
    created_at: 0,
    updated_at: 0,
  });
  claimThread.mockResolvedValue(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// transport: sendViaCfEmail
// ─────────────────────────────────────────────────────────────────────────────

  describe("sendViaCfEmail", () => {
  it("POSTs to {endpoint}/send with x-api-key and an idempotencyKey", async () => {
    const fetchMock = stubRelay(relayOk());

    const req: SendRequest = {
      from: { address: "alice@movo.com.my" },
      to: [{ address: "bob@example.com" }],
      subject: "Hi",
      text: "hello",
      headers: { "In-Reply-To": "<orig-abc@example.com>" },
    };
    const result: SendResult = await sendViaCfEmail(makeEnv(), req);
    expect(result.status).toBe("sent");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    expect(String(call?.[0])).toBe("https://cf-email.example.workers.dev/send");
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get("x-api-key")).toBe("cfes_test_key");

    const sent = sentBody(fetchMock);
    expect(sent.from).toBe("alice@movo.com.my");
    expect(sent.to).toBe("bob@example.com");
    expect(typeof sent.idempotencyKey).toBe("string");
    expect(String(sent.idempotencyKey).length).toBeGreaterThan(0);
    expect((sent.headers as Record<string, string>)["In-Reply-To"]).toBe(
      "<orig-abc@example.com>",
    );
  });

  it("forwards attachments to the cf-email relay", async () => {
    const fetchMock = stubRelay(relayOk());

    await sendViaCfEmail(makeEnv(), {
      from: { address: "alice@movo.com.my" },
      to: [{ address: "bob@example.com" }],
      subject: "Invoice",
      text: "attached",
      attachments: [
        {
          filename: "invoice.txt",
          contentType: "text/plain",
          contentBase64: "aGVsbG8=",
        },
      ],
    });

    expect(sentBody(fetchMock).attachments).toEqual([
      {
        filename: "invoice.txt",
        type: "text/plain",
        content: "aGVsbG8=",
        disposition: "attachment",
      },
    ]);
  });

  it("honors a caller-supplied idempotencyKey", async () => {
    const fetchMock = stubRelay(relayOk());
    await sendViaCfEmail(makeEnv(), {
      from: { address: "alice@movo.com.my" },
      to: [{ address: "bob@example.com" }],
      subject: "s",
      text: "t",
      idempotencyKey: "fixed-key-123",
    });
    expect(sentBody(fetchMock).idempotencyKey).toBe("fixed-key-123");
  });

  it("treats a non-2xx relay response as a typed failure", async () => {
    stubRelay(() => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    await expect(
      sendViaCfEmail(makeEnv(), {
        from: { address: "alice@movo.com.my" },
        to: [{ address: "bob@example.com" }],
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow();
  });

  it("surfaces network errors as a typed failure", async () => {
    const mock = vi.fn(async (): Promise<Response> => {
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", mock);
    await expect(
      sendViaCfEmail(makeEnv(), {
        from: { address: "alice@movo.com.my" },
        to: [{ address: "bob@example.com" }],
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// route: POST /send
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /send", () => {
  it("allows a non-owner to send from a shared mailbox and forces relay from to that mailbox", async () => {
    getSendableMailboxes.mockResolvedValue([SHARED_MAILBOX]);
    const fetchMock = stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        from: { address: "attacker@evil.com" },
        to: [{ address: "bob@example.com" }],
        subject: "Hi",
        text: "hello",
        mailboxId: SHARED_MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = sentBody(fetchMock);
    expect(sent.from).toBe(SHARED_MAILBOX.address);
    expect(String(sent.from)).not.toContain("evil.com");
  });

  it("forces from to the caller's mailbox even if a different from is supplied", async () => {
    const fetchMock = stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        from: { address: "attacker@evil.com" },
        to: [{ address: "bob@example.com" }],
        subject: "Hi",
        text: "hello",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = sentBody(fetchMock);
    expect(sent.from).toBe(MAILBOX.address);
    expect(String(sent.from)).not.toContain("evil.com");
  });

  it("rejects a mailboxId the authenticated user does not own", async () => {
    const fetchMock = stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Hi",
        text: "hello",
        mailboxId: "mbx_not_owned",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects another user's personal mailbox even when shared mailboxes are sendable", async () => {
    getSendableMailboxes.mockResolvedValue([SHARED_MAILBOX]);
    const fetchMock = stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Hi",
        text: "hello",
        mailboxId: "mbx_someone_personal",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires mailboxId when the authenticated user owns multiple mailboxes", async () => {
    getSendableMailboxes.mockResolvedValue([
      MAILBOX,
      {
        ...MAILBOX,
        id: "mbx_ops",
        address: "ops@movo.com.my",
      },
    ]);
    const fetchMock = stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Hi",
        text: "hello",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the sole owned mailbox when mailboxId is omitted", async () => {
    const fetchMock = stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Hi",
        text: "hello",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(sentBody(fetchMock).from).toBe(MAILBOX.address);
  });

  it("passes In-Reply-To/References derived from the replied thread", async () => {
    getThread.mockResolvedValue(
      threadWith("<orig-abc@example.com>", "<root-1@example.com>"),
    );
    const fetchMock = stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Re: thing",
        text: "reply body",
        threadId: "thr_1",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(getThread).toHaveBeenCalled();
    const headers = sentBody(fetchMock).headers as Record<string, string>;
    expect(headers["In-Reply-To"]).toBe("<orig-abc@example.com>");
    // References = prior chain + the replied message id.
    expect(headers.References).toContain("<root-1@example.com>");
    expect(headers.References).toContain("<orig-abc@example.com>");
  });

  it("does not send threading headers for a brand-new message (no threadId)", async () => {
    const fetchMock = stubRelay(relayOk());
    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "New",
        text: "x",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(getThread).not.toHaveBeenCalled();
    const headers = sentBody(fetchMock).headers as Record<string, string> | undefined;
    expect(headers?.["In-Reply-To"]).toBeUndefined();
  });

  it("assigns a brand-new shared-mailbox thread to the sender's database user id", async () => {
    getSendableMailboxes.mockResolvedValue([SHARED_MAILBOX]);
    stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "New shared",
        text: "hello",
        mailboxId: SHARED_MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(getUserByEmail).toHaveBeenCalledWith(expect.anything(), USER.email);
    const arg = insertOutboundMessage.mock.calls[0]?.[1] as {
      threadId?: string;
      assigneeId?: string | null;
    };
    expect(arg.threadId).toBeUndefined();
    expect(arg.assigneeId).toBe("db-user-nelson");
    expect(arg.assigneeId).not.toBe(USER.sub);
  });

  it("does not assign a brand-new personal-mailbox thread", async () => {
    stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "New personal",
        text: "hello",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(getUserByEmail).not.toHaveBeenCalled();
    const arg = insertOutboundMessage.mock.calls[0]?.[1] as {
      assigneeId?: string | null;
    };
    expect(arg.assigneeId).toBeUndefined();
  });

  it("claims an unassigned shared-mailbox thread when replying", async () => {
    getSendableMailboxes.mockResolvedValue([SHARED_MAILBOX]);
    getThread.mockResolvedValue(
      threadWith("<orig-shared@example.com>", null, SHARED_MAILBOX.id),
    );
    claimThread.mockResolvedValue(true);
    stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Re: shared",
        text: "reply",
        threadId: "thr_1",
        mailboxId: SHARED_MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(getUserByEmail).toHaveBeenCalledWith(expect.anything(), USER.email);
    expect(claimThread).toHaveBeenCalledWith(
      expect.anything(),
      "thr_1",
      "db-user-nelson",
    );
    const arg = insertOutboundMessage.mock.calls[0]?.[1] as {
      threadId?: string;
      assigneeId?: string | null;
    };
    expect(arg.threadId).toBe("thr_1");
    expect(arg.assigneeId).toBeUndefined();
  });

  it("does not claim an already-assigned shared-mailbox thread when replying", async () => {
    getSendableMailboxes.mockResolvedValue([SHARED_MAILBOX]);
    getThread.mockResolvedValue({
      ...threadWith("<orig-shared@example.com>", null, SHARED_MAILBOX.id),
      assignee_id: "db-user-existing",
    });
    stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Re: shared",
        text: "reply",
        threadId: "thr_1",
        mailboxId: SHARED_MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(getUserByEmail).not.toHaveBeenCalled();
    expect(claimThread).not.toHaveBeenCalled();
  });

  it("does not claim a personal-mailbox thread when replying", async () => {
    getThread.mockResolvedValue(
      threadWith("<orig-personal@example.com>", null, MAILBOX.id),
    );
    stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Re: personal",
        text: "reply",
        threadId: "thr_1",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(getUserByEmail).not.toHaveBeenCalled();
    expect(claimThread).not.toHaveBeenCalled();
  });

  it("still sends a shared-mailbox reply when the claim loses", async () => {
    getSendableMailboxes.mockResolvedValue([SHARED_MAILBOX]);
    getThread.mockResolvedValue(
      threadWith("<orig-shared@example.com>", null, SHARED_MAILBOX.id),
    );
    claimThread.mockResolvedValue(false);
    stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Re: shared",
        text: "reply",
        threadId: "thr_1",
        mailboxId: SHARED_MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(claimThread).toHaveBeenCalledWith(
      expect.anything(),
      "thr_1",
      "db-user-nelson",
    );
    expect(insertOutboundMessage).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("still sends a shared-mailbox reply when claiming throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    getSendableMailboxes.mockResolvedValue([SHARED_MAILBOX]);
    getThread.mockResolvedValue(
      threadWith("<orig-shared@example.com>", null, SHARED_MAILBOX.id),
    );
    claimThread.mockRejectedValue(new Error("claim failed"));
    stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Re: shared",
        text: "reply",
        threadId: "thr_1",
        mailboxId: SHARED_MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(insertOutboundMessage).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("writes a sent send_log row and persists the outbound message on success", async () => {
    stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Hi",
        text: "hello",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(insertOutboundMessage).toHaveBeenCalledTimes(1);
    expect(insertSendLog).toHaveBeenCalledTimes(1);
    const logCall = insertSendLog.mock.calls[0];
    expect(logCall).toBeDefined();
    const logArg = logCall?.[1] as {
      status: string;
      idempotencyKey: string;
      providerId: string | null;
    };
    expect(logArg.status).toBe("sent");
    expect(logArg.providerId).toBe("cfes_msg_1");
    expect(typeof logArg.idempotencyKey).toBe("string");
    expect(logArg.idempotencyKey.length).toBeGreaterThan(0);
  });

  it("sends, archives, and indexes outbound attachments", async () => {
    const fetchMock = stubRelay(relayOk());
    const env = makeEnv();

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Invoice",
        text: "attached",
        mailboxId: MAILBOX.id,
        attachments: [
          {
            filename: "invoice.txt",
            contentType: "text/plain",
            contentBase64: "aGVsbG8=",
          },
        ],
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect((sentBody(fetchMock).attachments as unknown[]).length).toBe(1);
    const arg = insertOutboundMessage.mock.calls[0]?.[1] as {
      id: string;
      hasAttachments: boolean;
      attachments: Array<{ filename: string; content: Uint8Array }>;
    };
    expect(arg.hasAttachments).toBe(true);
    expect(arg.attachments[0]?.filename).toBe("invoice.txt");
    expect(new TextDecoder().decode(arg.attachments[0]?.content)).toBe("hello");
    expect(env.MAIL_R2.put).toHaveBeenCalledWith(
      `att/${arg.id}/0`,
      expect.any(Uint8Array),
      expect.anything(),
    );
  });

  it("omits threadId for a brand-new (non-reply) send so the data layer creates a real thread", async () => {
    // Regression: previously this passed the idempotencyKey as threadId, which
    // pointed at a non-existent threads row → messages→threads FK violation →
    // the sent copy was never persisted. The route must now omit threadId so
    // insertOutboundMessage upserts a real parent thread.
    stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "New thread",
        text: "hello",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(insertOutboundMessage).toHaveBeenCalledTimes(1);
    const arg = insertOutboundMessage.mock.calls[0]?.[1] as { threadId?: string };
    expect(arg.threadId).toBeUndefined();
  });

  it("surfaces a 4xx and logs a failed send when the relay reports suppression", async () => {
    stubRelay(relayOk("suppressed"));

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "blocked@example.com" }],
        subject: "Hi",
        text: "hello",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // a failed send_log must still be recorded; the message is NOT persisted
    expect(insertSendLog).toHaveBeenCalledTimes(1);
    expect(insertOutboundMessage).not.toHaveBeenCalled();
    const logArg = insertSendLog.mock.calls[0]?.[1] as { status: string };
    expect(logArg.status).toBe("failed");
  });

  it("logs a failed send and returns 502 when the relay errors", async () => {
    stubRelay(() => new Response("err", { status: 500 }));
    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Hi",
        text: "hello",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );
    expect(res.status).toBe(502);
    expect(insertSendLog).toHaveBeenCalledTimes(1);
    const logArg = insertSendLog.mock.calls[0]?.[1] as { status: string };
    expect(logArg.status).toBe("failed");
  });

  it("rejects an empty recipient list with 400 and does not call the relay", async () => {
    const fetchMock = stubRelay(relayOk());
    const res = await makeApp().fetch(
      postBody({ to: [], subject: "Hi", text: "x", mailboxId: MAILBOX.id }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller has no provisioned mailbox", async () => {
    getSendableMailboxes.mockResolvedValue([]);
    const fetchMock = stubRelay(relayOk());
    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Hi",
        text: "x",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate-limits the mailbox: returns 429 once the per-mailbox cap is hit", async () => {
    // Pre-seed the KV counter at the cap so the next send is rejected.
    const kv = memKv();
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % 3600);
    await kv.put(`send_rl:${MAILBOX.id}:${windowStart}`, "100");
    const fetchMock = stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Hi",
        text: "x",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(kv),
    );

    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled(); // never reaches the relay
  });

  it("replays a prior result for a repeated Idempotency-Key without re-sending", async () => {
    const kv = memKv();
    const fetchMock = stubRelay(relayOk());
    const env = makeEnv(kv);

    const req = () =>
      new Request("http://localhost/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "client-key-xyz",
        },
        body: JSON.stringify({
          to: [{ address: "bob@example.com" }],
          subject: "Hi",
          text: "hello",
          mailboxId: MAILBOX.id,
        }),
      });

    const first = await makeApp().fetch(req(), env);
    expect(first.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same key again → replayed from KV, relay NOT called a second time.
    const second = await makeApp().fetch(req(), env);
    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = (await second.json()) as { id: string; status: string };
    expect(body.id).toBe("cfes_msg_1");
    expect(body.status).toBe("sent");
  });
});
