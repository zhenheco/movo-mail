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
const getMailboxById = vi.fn();
const getThreads = vi.fn();
const getThreadsVisible = vi.fn();
const getVisibleThreadsForUser = vi.fn();
const searchMessages = vi.fn();
const searchMessagesForOwner = vi.fn();
const getUserRole = vi.fn();
const listAllMailboxes = vi.fn();
const createMailbox = vi.fn();
const deleteMailbox = vi.fn();
const canUserReadThread = vi.fn();
const canUserReadBcc = vi.fn();
const claimThread = vi.fn(async (..._args: unknown[]): Promise<boolean> => false);
class MockMailboxExistsError extends Error {}
class MockInvalidThreadError extends Error {
  readonly code = "invalid_thread" as const;

  constructor(reason = "invalid thread") {
    super(reason);
    this.name = "InvalidThreadError";
  }
}

const getOwnedThreadForSend = vi.fn();
const claimSendAttempt = vi.fn();
const getSendAttempt = vi.fn();
const transitionSendAttempt = vi.fn();
const insertOutboundMessage = vi.fn(async (..._args: unknown[]): Promise<string> => "msg-row-1");
const insertSendLog = vi.fn(async (..._args: unknown[]): Promise<string> => "send-log-1");
const insertAudit = vi.fn(async (..._args: unknown[]): Promise<string> => "audit-1");

vi.mock("../src/db", () => ({
  getThread: (...a: unknown[]) => getThread(...a),
  getMailboxesForUser: (...a: unknown[]) => getMailboxesForUser(...a),
  getSendableMailboxes: (...a: unknown[]) => getSendableMailboxes(...a),
  getUserByEmail: (...a: unknown[]) => getUserByEmail(...a),
  getMailboxById: (...a: unknown[]) => getMailboxById(...a),
  getThreads: (...a: unknown[]) => getThreads(...a),
  getThreadsVisible: (...a: unknown[]) => getThreadsVisible(...a),
  getVisibleThreadsForUser: (...a: unknown[]) => getVisibleThreadsForUser(...a),
  searchMessages: (...a: unknown[]) => searchMessages(...a),
  searchMessagesForOwner: (...a: unknown[]) => searchMessagesForOwner(...a),
  getUserRole: (...a: unknown[]) => getUserRole(...a),
  listAllMailboxes: (...a: unknown[]) => listAllMailboxes(...a),
  createMailbox: (...a: unknown[]) => createMailbox(...a),
  deleteMailbox: (...a: unknown[]) => deleteMailbox(...a),
  MailboxExistsError: MockMailboxExistsError,
  canUserReadThread: (...a: unknown[]) => canUserReadThread(...a),
  canUserReadBcc: (...a: unknown[]) => canUserReadBcc(...a),
  claimThread: (...a: unknown[]) => claimThread(...a),
  InvalidThreadError: MockInvalidThreadError,
  getOwnedThreadForSend: (...a: unknown[]) => getOwnedThreadForSend(...a),
  claimSendAttempt: (...a: unknown[]) => claimSendAttempt(...a),
  getSendAttempt: (...a: unknown[]) => getSendAttempt(...a),
  transitionSendAttempt: (...a: unknown[]) => transitionSendAttempt(...a),
  insertOutboundMessage: (...a: unknown[]) => insertOutboundMessage(...a),
  insertSendLog: (...a: unknown[]) => insertSendLog(...a),
  insertAudit: (...a: unknown[]) => insertAudit(...a),
}));

// imported AFTER vi.mock so the route picks up the mocked db
const { sendRoutes } = await import("../src/api/send");
const { apiRoutes } = await import("../src/api/routes");
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
  owner_id: "db-user-nelson",
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

/** Mount the complete protected API composition at the real /api prefix. */
function makeComposedApp(): Hono<AccessEnv> {
  const app = new Hono<AccessEnv>();
  app.use("/api/*", async (c, next) => {
    c.set("user", USER);
    await next();
  });
  app.route("/api", apiRoutes());
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

interface MockSendAttempt {
  id: string;
  mailbox_id: string;
  idempotency_key: string;
  canonical_hash: string;
  provider_id: string | null;
  message_id: string | null;
  status: "queued" | "pending" | "sent" | "failed" | "sent_unarchived";
  error: string | null;
  created_at: number;
  updated_at: number;
}

const durableAttempts = new Map<string, MockSendAttempt>();

function installDefaultDbMockBehavior(): void {
  getOwnedThreadForSend.mockImplementation(
    async (
      env: Env,
      threadId: string,
      mailboxId: string,
      viewer: { userId: string | null; isAdmin: boolean },
    ) => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) {
        throw new MockInvalidThreadError("invalid thread id");
      }
      const thread = await getThread(env, threadId);
      if (
        !thread ||
        typeof thread !== "object" ||
        (thread as { mailbox_id?: unknown }).mailbox_id !== mailboxId
      ) {
        throw new MockInvalidThreadError("thread is not owned by this mailbox");
      }
      if (
        mailboxId === SHARED_MAILBOX.id &&
        typeof (thread as { assignee_id?: unknown }).assignee_id === "string" &&
        !viewer.isAdmin &&
        (thread as { assignee_id: string }).assignee_id !== viewer.userId
      ) {
        throw new MockInvalidThreadError("thread is not visible to this user");
      }
      return thread;
    },
  );

  claimSendAttempt.mockImplementation(
    async (
      _env: Env,
      input: { mailboxId: string; idempotencyKey: string; canonicalHash: string },
    ) => {
      const key = `${input.mailboxId}:${input.idempotencyKey}`;
      const existing = durableAttempts.get(key);
      if (existing) {
        return existing.canonical_hash === input.canonicalHash
          ? { kind: "replay", attempt: { ...existing } }
          : { kind: "mismatch", attempt: { ...existing } };
      }
      const attempt: MockSendAttempt = {
        id: `attempt-${durableAttempts.size + 1}`,
        mailbox_id: input.mailboxId,
        idempotency_key: input.idempotencyKey,
        canonical_hash: input.canonicalHash,
        provider_id: null,
        message_id: null,
        status: "queued",
        error: null,
        created_at: 1,
        updated_at: 1,
      };
      durableAttempts.set(key, attempt);
      return { kind: "claimed", attempt: { ...attempt } };
    },
  );

  getSendAttempt.mockImplementation(async (_env: Env, id: string) => {
    for (const attempt of durableAttempts.values()) {
      if (attempt.id === id) return { ...attempt };
    }
    return null;
  });

  transitionSendAttempt.mockImplementation(
    async (
      _env: Env,
      input: {
        id: string;
        from: MockSendAttempt["status"];
        to: MockSendAttempt["status"];
        providerId?: string | null;
        messageId?: string | null;
        error?: string | null;
      },
    ) => {
      const attempt = [...durableAttempts.values()].find(
        (candidate) => candidate.id === input.id,
      );
      if (!attempt || attempt.status !== input.from) {
        throw new Error(`invalid send attempt transition: ${input.from} -> ${input.to}`);
      }
      attempt.status = input.to;
      if (input.providerId !== undefined) attempt.provider_id = input.providerId;
      if (input.messageId !== undefined) attempt.message_id = input.messageId;
      if (input.error !== undefined) attempt.error = input.error;
      attempt.updated_at += 1;
    },
  );
}

function postBody(
  body: unknown,
  extraHeaders: Record<string, string> = {},
  path = "/send",
): Request {
  const payload =
    body && typeof body === "object" && !Array.isArray(body) &&
    !("contract_version" in (body as Record<string, unknown>))
      ? { contract_version: "movo-send-v1", ...(body as Record<string, unknown>) }
      : body;
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(payload),
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
  canUserReadBcc.mockReset();
  canUserReadBcc.mockResolvedValue(true);
  claimThread.mockResolvedValue(false);
  durableAttempts.clear();
  installDefaultDbMockBehavior();
});

// ─────────────────────────────────────────────────────────────────────────────
// transport: sendViaCfEmail
// ─────────────────────────────────────────────────────────────────────────────

  describe("sendViaCfEmail", () => {
  it("POSTs the versioned relay contract with x-api-key and an Idempotency-Key header", async () => {
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
    expect(headers.get("Idempotency-Key")).toBeTruthy();

    const sent = sentBody(fetchMock);
    expect(sent.relay_contract_version).toBe("cf-mail-send-v2");
    expect(sent.from).toBe("alice@movo.com.my");
    expect(sent.to).toEqual(["bob@example.com"]);
    expect(sent).not.toHaveProperty("idempotencyKey");
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
    const call = fetchMock.mock.calls[0];
    expect(new Headers(call?.[1]?.headers).get("Idempotency-Key")).toBe(
      "fixed-key-123",
    );
    expect(sentBody(fetchMock)).not.toHaveProperty("idempotencyKey");
  });

  it("emits the versioned relay contract with recipient arrays and an Idempotency-Key header", async () => {
    const fetchMock = stubRelay(relayOk());

    await sendViaCfEmail(makeEnv(), {
      from: { address: "alice@movo.com.my" },
      to: [
        { address: "bob@example.com" },
        { address: "carol@example.com", name: "Carol" },
      ],
      cc: [{ address: "copy@example.com" }],
      bcc: [{ address: "secret@example.com" }],
      subject: "Contract",
      text: "hello",
      headers: {
        "In-Reply-To": "<orig@example.com>",
        References: "<prior@example.com> <orig@example.com>",
      },
      attachments: [
        {
          filename: "inline.txt",
          contentType: "text/plain",
          contentBase64: "aGVsbG8=",
          contentId: "part-1",
          inline: true,
        },
      ],
      idempotencyKey: "fixed-wire-key",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    const requestHeaders = new Headers(call?.[1]?.headers);
    expect(requestHeaders.get("Idempotency-Key")).toBe("fixed-wire-key");

    expect(sentBody(fetchMock)).toEqual({
      relay_contract_version: "cf-mail-send-v2",
      to: ["bob@example.com", "carol@example.com"],
      cc: ["copy@example.com"],
      bcc: ["secret@example.com"],
      from: "alice@movo.com.my",
      subject: "Contract",
      text: "hello",
      headers: {
        "In-Reply-To": "<orig@example.com>",
        References: "<prior@example.com> <orig@example.com>",
      },
      attachments: [
        {
          filename: "inline.txt",
          type: "text/plain",
          content: "aGVsbG8=",
          disposition: "inline",
          contentId: "part-1",
        },
      ],
    });
  });

  it("rejects relay payloads above its independent 32-attachment boundary", async () => {
    const fetchMock = stubRelay(relayOk());

    await expect(
      sendViaCfEmail(makeEnv(), {
        from: { address: "alice@movo.com.my" },
        to: [{ address: "bob@example.com" }],
        subject: "Too many relay attachments",
        text: "hello",
        attachments: Array.from({ length: 33 }, (_, i) => ({
          filename: `file-${i}.txt`,
          contentType: "text/plain",
          contentBase64: "aA==",
        })),
      }),
    ).rejects.toMatchObject({ status: 400, relayStatus: "attachment_limit" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects relay payloads above its independent 50-recipient boundary", async () => {
    const fetchMock = stubRelay(relayOk());

    await expect(
      sendViaCfEmail(makeEnv(), {
        from: { address: "alice@movo.com.my" },
        to: Array.from({ length: 51 }, (_, i) => ({
          address: `recipient-${i}@example.com`,
        })),
        subject: "Too many relay recipients",
        text: "hello",
      }),
    ).rejects.toMatchObject({ status: 400, relayStatus: "recipient_limit" });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("maps a versioned relay error envelope to its stable error code", async () => {
    stubRelay(
      () =>
        new Response(
          JSON.stringify({
            error: { code: "recipient_limit", message: "too many recipients" },
          }),
          { status: 400 },
        ),
    );

    await expect(
      sendViaCfEmail(makeEnv(), {
        from: { address: "alice@movo.com.my" },
        to: [{ address: "bob@example.com" }],
        subject: "s",
        text: "t",
      }),
    ).rejects.toMatchObject({ status: 400, relayStatus: "recipient_limit" });
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
  it("requires the exact Movo contract version and rejects unknown keys", async () => {
    const fetchMock = stubRelay(relayOk());

    const missingVersion = await makeApp().fetch(
      new Request("http://localhost/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: [{ address: "bob@example.com" }],
          subject: "Hi",
          text: "hello",
          mailboxId: MAILBOX.id,
        }),
      }),
      makeEnv(),
    );
    expect(missingVersion.status).toBe(400);
    expect(await missingVersion.json()).toMatchObject({
      code: "invalid_request",
    });

    const unknownKey = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Hi",
        text: "hello",
        mailboxId: MAILBOX.id,
        unexpected: true,
      }),
      makeEnv(),
    );
    expect(unknownKey.status).toBe(400);
    expect(await unknownKey.json()).toMatchObject({ code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves Cc, Bcc, all To recipients, and the request Idempotency-Key on the relay wire", async () => {
    const fetchMock = stubRelay(relayOk());
    const key = "request-key-1";

    const res = await makeApp().fetch(
      postBody(
        {
          to: [
            { address: "bob@example.com" },
            { address: "carol@example.com" },
          ],
          cc: [{ address: "copy@example.com" }],
          bcc: [{ address: "secret@example.com" }],
          subject: "Recipients",
          text: "hello",
          idempotencyKey: key,
          mailboxId: MAILBOX.id,
        },
        { "Idempotency-Key": key },
      ),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody(fetchMock)).toMatchObject({
      relay_contract_version: "cf-mail-send-v2",
      from: MAILBOX.address,
      to: ["bob@example.com", "carol@example.com"],
      cc: ["copy@example.com"],
      bcc: ["secret@example.com"],
    });
    const call = fetchMock.mock.calls[0];
    expect(new Headers(call?.[1]?.headers).get("Idempotency-Key")).toBe(key);
  });

  it("accepts exactly 50 combined recipients and 10 attachments in one relay request", async () => {
    const fetchMock = stubRelay(relayOk());
    const to = Array.from({ length: 48 }, (_, i) => ({
      address: `to-${i}@example.com`,
    }));
    const cc = [{ address: "cc@example.com" }];
    const bcc = [{ address: "bcc@example.com" }];
    const attachments = Array.from({ length: 10 }, (_, i) => ({
      filename: `file-${i}.txt`,
      contentType: "text/plain",
      contentBase64: "aA==",
    }));

    const res = await makeApp().fetch(
      postBody({
        to,
        cc,
        bcc,
        subject: "Boundaries",
        text: "hello",
        attachments,
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = sentBody(fetchMock);
    expect(sent.to).toHaveLength(48);
    expect(sent.cc).toEqual(["cc@example.com"]);
    expect(sent.bcc).toEqual(["bcc@example.com"]);
    expect(sent.attachments).toHaveLength(10);
  });

  it("rejects 51 combined recipients before relay submission", async () => {
    const fetchMock = stubRelay(relayOk());
    const res = await makeApp().fetch(
      postBody({
        to: Array.from({ length: 50 }, (_, i) => ({
          address: `to-${i}@example.com`,
        })),
        cc: [{ address: "one-too-many@example.com" }],
        subject: "Too many recipients",
        text: "hello",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "recipient_limit" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(insertOutboundMessage).not.toHaveBeenCalled();
    expect(insertSendLog).not.toHaveBeenCalled();
  });

  it("rejects 11 attachments atomically before relay submission", async () => {
    const fetchMock = stubRelay(relayOk());
    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Too many files",
        text: "hello",
        attachments: Array.from({ length: 11 }, (_, i) => ({
          filename: `file-${i}.txt`,
          contentType: "text/plain",
          contentBase64: "aA==",
        })),
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "attachment_limit" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(insertOutboundMessage).not.toHaveBeenCalled();
    expect(insertSendLog).not.toHaveBeenCalled();
  });

  it("rejects malformed recipients instead of silently dropping them", async () => {
    const fetchMock = stubRelay(relayOk());
    const res = await makeApp().fetch(
      postBody({
        to: [
          { address: "valid@example.com" },
          { address: "not-an-email" },
        ],
        subject: "Invalid recipient",
        text: "hello",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_recipient" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed", "thr invalid", null],
    ["cross-mailbox", "thr_1", "mbx_other"],
  ])(
    "rejects an explicit %s thread with invalid_thread instead of sending unthreaded",
    async (_label, threadId, threadMailboxId) => {
      if (threadMailboxId) {
        getThread.mockResolvedValue(
          threadWith("<other@example.com>", null, threadMailboxId),
        );
      }
      const fetchMock = stubRelay(relayOk());

      const res = await makeApp().fetch(
        postBody({
          to: [{ address: "bob@example.com" }],
          subject: "Invalid thread",
          text: "hello",
          threadId,
          mailboxId: MAILBOX.id,
        }),
        makeEnv(),
      );

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await res.json()).toMatchObject({ code: "invalid_thread" });
      expect(getOwnedThreadForSend).toHaveBeenCalledWith(
        expect.anything(),
        threadId,
        MAILBOX.id,
        { userId: "db-user-nelson", isAdmin: false },
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects unavailable Reply All Bcc with exact confirmation but no typed Bcc before relay or persistence", async () => {
    getThread.mockResolvedValue(threadWith("<orig@example.com>", null));
    const fetchMock = stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "client@example.com" }],
        bcc: [],
        subject: "Re: thing",
        text: "reply",
        threadId: "thr_1",
        mailboxId: MAILBOX.id,
        replyMode: "reply-all",
        bccProvenance: "known-nonempty",
        bccConfirmation: "confirmed-missing-original-bcc",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "reply_all_bcc_confirmation_required",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(insertOutboundMessage).not.toHaveBeenCalled();
    expect(insertSendLog).not.toHaveBeenCalled();
  });

  it("normalizes Reply All from the latest stored source message on the relay and persisted copy", async () => {
    getThread.mockResolvedValue({
      ...threadWith("<orig@example.com>", "<root@example.com>"),
      messages: [
        {
          ...threadWith("<orig@example.com>", "<root@example.com>").messages[0],
          from_address: "sender@example.com",
          from_name: "Sender",
          to_addresses: JSON.stringify([
            MAILBOX.address,
            "To@example.com",
            "TO@example.com",
          ]),
          cc_addresses: JSON.stringify([
            "cc@example.com",
            "DUP@example.com",
            MAILBOX.address,
          ]),
          bcc_addresses: JSON.stringify([
            "hidden@example.com",
            "dup@example.com",
            "bcc-only@example.com",
          ]),
        },
      ],
    });
    const fetchMock = stubRelay(relayOk());
    const env = makeEnv();

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "client-controlled@example.com" }],
        cc: [{ address: "wrong-copy@example.com" }],
        bcc: [],
        subject: "Re: thing",
        text: "reply",
        threadId: "thr_1",
        mailboxId: MAILBOX.id,
        replyMode: "reply-all",
        bccProvenance: "known-nonempty",
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(sentBody(fetchMock)).toMatchObject({
      to: ["sender@example.com", "To@example.com"],
      cc: ["cc@example.com", "DUP@example.com"],
      bcc: ["hidden@example.com", "bcc-only@example.com"],
    });
    expect(sentBody(fetchMock).headers).not.toHaveProperty("Bcc");
    expect(insertOutboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toAddresses: ["sender@example.com", "To@example.com"],
        ccAddresses: ["cc@example.com", "DUP@example.com"],
        bccAddresses: ["hidden@example.com", "bcc-only@example.com"],
      }),
    );
    const logArg = insertSendLog.mock.calls[0]?.[1] as {
      toAddresses: string[];
      bccAddresses?: string[];
    };
    expect(logArg.toAddresses).toEqual(["sender@example.com", "To@example.com"]);
    expect(logArg).not.toHaveProperty("bccAddresses");
    const rawPut = vi.mocked(env.MAIL_R2.put).mock.calls.find(
      ([key]) => typeof key === "string" && key.startsWith("msg/"),
    );
    expect(String(rawPut?.[1])).toContain(
      "To: sender@example.com, To@example.com",
    );
    expect(String(rawPut?.[1])).toContain(
      "Cc: cc@example.com, DUP@example.com",
    );
    expect(String(rawPut?.[1])).not.toContain("client-controlled@example.com");
    expect(String(rawPut?.[1])).not.toContain("Bcc:");
    expect(await res.json()).toEqual({
      ok: true,
      id: "cfes_msg_1",
      status: "sent",
      messageId: "msg-row-1",
    });
  });

  it("does not auto-use original Bcc for an unassigned shared viewer", async () => {
    getSendableMailboxes.mockResolvedValue([SHARED_MAILBOX]);
    getThread.mockResolvedValue({
      ...threadWith("<orig-shared@example.com>", null, SHARED_MAILBOX.id),
      messages: [
        {
          ...threadWith("<orig-shared@example.com>", null, SHARED_MAILBOX.id)
            .messages[0],
          bcc_addresses: JSON.stringify(["secret@example.com"]),
        },
      ],
    });
    canUserReadBcc.mockResolvedValue(false);
    const fetchMock = stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "client@example.com" }],
        bcc: [],
        subject: "Re: shared",
        text: "reply",
        threadId: "thr_1",
        mailboxId: SHARED_MAILBOX.id,
        replyMode: "reply-all",
        bccProvenance: "known-nonempty",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "reply_all_bcc_confirmation_required",
    });
    expect(canUserReadBcc).toHaveBeenCalledWith(
      expect.anything(),
      "m1",
      { userId: "db-user-nelson", isAdmin: false },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(insertOutboundMessage).not.toHaveBeenCalled();
  });

  it("allows an unassigned shared viewer only through confirmed typed Bcc", async () => {
    getSendableMailboxes.mockResolvedValue([SHARED_MAILBOX]);
    getThread.mockResolvedValue({
      ...threadWith("<orig-shared@example.com>", null, SHARED_MAILBOX.id),
      messages: [
        {
          ...threadWith("<orig-shared@example.com>", null, SHARED_MAILBOX.id)
            .messages[0],
          bcc_addresses: JSON.stringify(["secret@example.com"]),
        },
      ],
    });
    canUserReadBcc.mockResolvedValue(false);
    const fetchMock = stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "client@example.com" }],
        bcc: [{ address: "manual@example.com" }],
        subject: "Re: shared",
        text: "reply",
        threadId: "thr_1",
        mailboxId: SHARED_MAILBOX.id,
        replyMode: "reply-all",
        bccProvenance: "unavailable",
        bccConfirmation: "confirmed-missing-original-bcc",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(sentBody(fetchMock).bcc).toEqual(["manual@example.com"]);
    expect(sentBody(fetchMock).bcc).not.toContain("secret@example.com");
  });

  it("covers v2 Reply All through the protected /api composition", async () => {
    getThread.mockResolvedValue({
      ...threadWith("<orig@example.com>", null),
      messages: [
        {
          ...threadWith("<orig@example.com>", null).messages[0],
          from_address: "sender@example.com",
          to_addresses: JSON.stringify(["to@example.com"]),
          cc_addresses: JSON.stringify(["cc@example.com"]),
          bcc_addresses: JSON.stringify(["hidden@example.com"]),
        },
      ],
    });
    const fetchMock = stubRelay(relayOk());

    const res = await makeComposedApp().fetch(
      postBody(
        {
          to: [{ address: "client-controlled@example.com" }],
          cc: [],
          bcc: [],
          subject: "Re: thing",
          text: "reply",
          threadId: "thr_1",
          mailboxId: MAILBOX.id,
          replyMode: "reply-all",
          bccProvenance: "known-nonempty",
        },
        {},
        "/api/send",
      ),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(sentBody(fetchMock)).toMatchObject({
      relay_contract_version: "cf-mail-send-v2",
      to: ["sender@example.com", "to@example.com"],
      cc: ["cc@example.com"],
      bcc: ["hidden@example.com"],
    });
    expect(await res.json()).toMatchObject({
      ok: true,
      id: "cfes_msg_1",
      status: "sent",
    });
  });

  it("rejects stored-unavailable Reply All Bcc without confirmation before relay", async () => {
    getThread.mockResolvedValue({
      ...threadWith("<orig@example.com>", null),
      messages: [
        {
          ...threadWith("<orig@example.com>", null).messages[0],
          bcc_addresses: null,
        },
      ],
    });
    const fetchMock = stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "client-controlled@example.com" }],
        bcc: [{ address: "manual@example.com" }],
        subject: "Re: thing",
        text: "reply",
        threadId: "thr_1",
        mailboxId: MAILBOX.id,
        replyMode: "reply-all",
        bccProvenance: "known-nonempty",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Reply All requires confirmation when original Bcc is unavailable.",
      code: "reply_all_bcc_confirmation_required",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(insertOutboundMessage).not.toHaveBeenCalled();
    expect(insertSendLog).not.toHaveBeenCalled();
  });

  it.each([
    ["message_id", { message_id: "not-a-message-id" }],
    ["references", { references: "<root@example.com> malformed-reference" }],
  ])(
    "rejects malformed stored %s on an explicit reply before provider or persistence",
    async (_field, messageOverride) => {
      getThread.mockResolvedValue({
        ...threadWith("<orig@example.com>", "<root@example.com>"),
        messages: [
          {
            ...threadWith("<orig@example.com>", "<root@example.com>").messages[0],
            ...messageOverride,
          },
        ],
      });
      const fetchMock = stubRelay(relayOk());

      const res = await makeApp().fetch(
        postBody({
          to: [{ address: "bob@example.com" }],
          subject: "Invalid stored threading",
          text: "reply",
          threadId: "thr_1",
          mailboxId: MAILBOX.id,
        }),
        makeEnv(),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_thread" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(insertOutboundMessage).not.toHaveBeenCalled();
      expect(insertSendLog).not.toHaveBeenCalled();
    },
  );

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

  it("rejects another user's assigned shared-mailbox thread before relay", async () => {
    getSendableMailboxes.mockResolvedValue([SHARED_MAILBOX]);
    getThread.mockResolvedValue({
      ...threadWith("<orig-shared@example.com>", null, SHARED_MAILBOX.id),
      assignee_id: "db-user-existing",
    });
    const fetchMock = stubRelay(relayOk());

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

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_thread" });
    expect(getUserByEmail).toHaveBeenCalledWith(expect.anything(), USER.email);
    expect(claimThread).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(insertOutboundMessage).not.toHaveBeenCalled();
  });

  it("allows an assigned shared-mailbox thread for its assignee", async () => {
    getSendableMailboxes.mockResolvedValue([SHARED_MAILBOX]);
    getThread.mockResolvedValue({
      ...threadWith("<orig-shared@example.com>", null, SHARED_MAILBOX.id),
      assignee_id: "db-user-nelson",
    });
    const fetchMock = stubRelay(relayOk());

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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows an admin to reply to another user's assigned shared-mailbox thread", async () => {
    getSendableMailboxes.mockResolvedValue([SHARED_MAILBOX]);
    getUserByEmail.mockResolvedValue({
      id: "db-user-admin",
      email: USER.email,
      name: USER.name ?? null,
      role: "admin",
      created_at: 0,
      updated_at: 0,
    });
    getThread.mockResolvedValue({
      ...threadWith("<orig-shared@example.com>", null, SHARED_MAILBOX.id),
      assignee_id: "db-user-existing",
    });
    const fetchMock = stubRelay(relayOk());

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
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(getUserByEmail).toHaveBeenCalledWith(expect.anything(), USER.email);
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

  it("rejects oversized attachments before calling the relay", async () => {
    const fetchMock = stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Too large",
        text: "attached",
        mailboxId: MAILBOX.id,
        attachments: [
          {
            filename: "large.txt",
            contentType: "text/plain",
            contentBase64: "A".repeat(5 * 1024 * 1024 + 4),
          },
        ],
      }),
      makeEnv(),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports sent_unarchived and does not resend after attachment archival fails", async () => {
    const fetchMock = stubRelay(relayOk());
    const env = makeEnv();
    vi.mocked(env.MAIL_R2.put).mockRejectedValueOnce(new Error("R2 down"));

    const request = () =>
      postBody(
        {
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
        },
        { "Idempotency-Key": "archive-failure-key" },
      );

    const res = await makeApp().fetch(request(), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "sent_unarchived" });
    expect(insertOutboundMessage).not.toHaveBeenCalled();
    expect(insertSendLog).toHaveBeenCalledTimes(1);
    expect(insertSendLog.mock.calls[0]?.[1]).toMatchObject({
      status: "sent_unarchived",
      providerId: "cfes_msg_1",
    });
    expect(transitionSendAttempt).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        from: "pending",
        to: "sent_unarchived",
        providerId: "cfes_msg_1",
      }),
    );

    const replay = await makeApp().fetch(request(), env);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: "sent_unarchived" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports sent_unarchived when the raw EML archive fails", async () => {
    const fetchMock = stubRelay(relayOk());
    const env = makeEnv();
    vi.mocked(env.MAIL_R2.put).mockRejectedValue(new Error("raw R2 down"));

    const res = await makeApp().fetch(
      postBody(
        {
          to: [{ address: "bob@example.com" }],
          subject: "Raw archive failure",
          text: "hello",
          mailboxId: MAILBOX.id,
        },
        { "Idempotency-Key": "raw-archive-failure-key" },
      ),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "sent_unarchived" });
    expect(insertOutboundMessage).not.toHaveBeenCalled();
    expect(insertSendLog.mock.calls[0]?.[1]).toMatchObject({
      status: "sent_unarchived",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports sent_unarchived when outbound persistence fails", async () => {
    stubRelay(relayOk());
    const env = makeEnv();
    insertOutboundMessage.mockRejectedValueOnce(new Error("D1 down"));

    const res = await makeApp().fetch(
      postBody(
        {
          to: [{ address: "bob@example.com" }],
          subject: "Persistence failure",
          text: "hello",
          mailboxId: MAILBOX.id,
        },
        { "Idempotency-Key": "persistence-failure-key" },
      ),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "sent_unarchived" });
    expect(insertSendLog.mock.calls[0]?.[1]).toMatchObject({
      status: "sent_unarchived",
      error: expect.stringContaining("D1 down"),
    });
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

  it("returns message_size_limit as a 400 and records a failed attempt", async () => {
    const fetchMock = stubRelay(relayOk());
    const env = makeEnv();
    const idempotencyKey = "oversized-message-key";

    const res = await makeApp().fetch(
      postBody(
        {
          to: [{ address: "bob@example.com" }],
          subject: "Oversized message",
          text: "x".repeat(5 * 1024 * 1024),
          mailboxId: MAILBOX.id,
        },
        { "Idempotency-Key": idempotencyKey },
      ),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Message exceeds the 5 MiB email limit.",
      code: "message_size_limit",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(insertSendLog.mock.calls[0]?.[1]).toMatchObject({
      status: "failed",
    });
    expect(transitionSendAttempt).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        from: "pending",
        to: "failed",
        error: expect.stringContaining("message_size_limit"),
      }),
    );

    const replay = await makeApp().fetch(
      postBody(
        {
          to: [{ address: "bob@example.com" }],
          subject: "Oversized message",
          text: "x".repeat(5 * 1024 * 1024),
          mailboxId: MAILBOX.id,
        },
        { "Idempotency-Key": idempotencyKey },
      ),
      env,
    );
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({
      error: "Message exceeds the 5 MiB email limit.",
      code: "message_size_limit",
    });
    expect(fetchMock).not.toHaveBeenCalled();
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
          contract_version: "movo-send-v1",
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

  it("claims and transitions a durable Idempotency-Key attempt, then replays without a second relay call", async () => {
    const fetchMock = stubRelay(relayOk());
    const env = makeEnv();
    const req = () =>
      postBody(
        {
          to: [{ address: "bob@example.com" }],
          subject: "Durable retry",
          text: "hello",
          mailboxId: MAILBOX.id,
        },
        { "Idempotency-Key": "durable-key-1" },
      );

    const first = await makeApp().fetch(req(), env);

    expect(first.status).toBe(200);
    expect(claimSendAttempt).toHaveBeenCalledTimes(1);
    expect(claimSendAttempt.mock.calls[0]?.[1]).toMatchObject({
      mailboxId: MAILBOX.id,
      idempotencyKey: "durable-key-1",
      canonicalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(getSendAttempt).toHaveBeenCalledWith(expect.anything(), "attempt-1");
    expect(transitionSendAttempt).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ id: "attempt-1", from: "queued", to: "pending" }),
    );
    expect(transitionSendAttempt).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ id: "attempt-1", from: "pending", to: "sent" }),
    );

    const second = await makeApp().fetch(req(), env);

    expect(second.status).toBe(200);
    expect(claimSendAttempt).toHaveBeenCalledTimes(2);
    expect(getSendAttempt).toHaveBeenCalledTimes(2);
    expect(transitionSendAttempt).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await second.json()).toMatchObject({
      ok: true,
      id: "cfes_msg_1",
      status: "sent",
    });
  });

  it("rejects reuse of an Idempotency-Key for a different request", async () => {
    const kv = memKv();
    const fetchMock = stubRelay(relayOk());
    const env = makeEnv(kv);

    const first = await makeApp().fetch(
      postBody(
        {
          to: [{ address: "bob@example.com" }],
          subject: "First",
          text: "hello",
          mailboxId: MAILBOX.id,
        },
        { "Idempotency-Key": "reused-key" },
      ),
      env,
    );
    expect(first.status).toBe(200);

    const second = await makeApp().fetch(
      postBody(
        {
          to: [{ address: "carol@example.com" }],
          subject: "Different",
          text: "hello",
          mailboxId: MAILBOX.id,
        },
        { "Idempotency-Key": "reused-key" },
      ),
      env,
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "idempotency_mismatch" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("durably claims a local attempt even without a client idempotency key", async () => {
    const fetchMock = stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Durable local claim",
        text: "hello",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(claimSendAttempt).toHaveBeenCalledTimes(1);
    expect(claimSendAttempt.mock.calls[0]?.[1]).toMatchObject({
      mailboxId: MAILBOX.id,
      idempotencyKey: expect.any(String),
      canonicalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(transitionSendAttempt).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ from: "queued", to: "pending" }),
    );
    expect(transitionSendAttempt).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ from: "pending", to: "sent" }),
    );
  });

  it("fails closed when the relay returns status=failed", async () => {
    const fetchMock = stubRelay(relayOk("failed"));
    const env = makeEnv();

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Relay failed",
        text: "hello",
        mailboxId: MAILBOX.id,
      }),
      env,
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Failed to send the message.",
      code: "relay_unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(insertOutboundMessage).not.toHaveBeenCalled();
    expect(vi.mocked(env.MAIL_R2.put)).not.toHaveBeenCalled();
    expect(insertSendLog.mock.calls[0]?.[1]).toMatchObject({
      status: "failed",
      providerId: "cfes_msg_1",
    });
    expect(transitionSendAttempt).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        from: "pending",
        to: "failed",
        providerId: "cfes_msg_1",
      }),
    );
  });

  it("fails closed when the relay returns an unknown status", async () => {
    const fetchMock = stubRelay(relayOk("accepted"));
    const env = makeEnv();

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Unknown relay status",
        text: "hello",
        mailboxId: MAILBOX.id,
      }),
      env,
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Failed to send the message.",
      code: "relay_unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(insertOutboundMessage).not.toHaveBeenCalled();
    expect(transitionSendAttempt).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ from: "pending", to: "failed" }),
    );
  });

  it("returns pending for a pending relay and replays the same pending envelope", async () => {
    const fetchMock = stubRelay(relayOk("pending"));
    const env = makeEnv();
    const request = () =>
      postBody(
        {
          to: [{ address: "bob@example.com" }],
          subject: "Relay pending",
          text: "hello",
          mailboxId: MAILBOX.id,
        },
        { "Idempotency-Key": "pending-replay-key" },
      );

    const first = await makeApp().fetch(request(), env);
    const firstBody = await first.json();

    expect(first.status).toBe(200);
    expect(firstBody).toMatchObject({ ok: true, status: "pending" });
    expect(insertOutboundMessage).not.toHaveBeenCalled();
    expect(
      insertSendLog.mock.calls.some(([, input]) =>
        Boolean(input && typeof input === "object" && "status" in input && input.status === "sent"),
      ),
    ).toBe(false);
    expect(transitionSendAttempt).toHaveBeenCalledTimes(2);
    expect(transitionSendAttempt).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        from: "queued",
        to: "pending",
      }),
    );
    expect(firstBody).toMatchObject({ id: "cfes_msg_1" });

    const second = await makeApp().fetch(request(), env);
    const secondBody = await second.json();

    expect(second.status).toBe(200);
    expect(secondBody).toEqual(firstBody);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(transitionSendAttempt).toHaveBeenCalledTimes(2);
    expect(transitionSendAttempt).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        from: "pending",
        to: "pending",
        providerId: "cfes_msg_1",
      }),
    );
  });

  it("returns sent_unarchived when archival fails without a client idempotency key", async () => {
    const fetchMock = stubRelay(relayOk());
    const env = makeEnv();
    vi.mocked(env.MAIL_R2.put).mockRejectedValueOnce(new Error("R2 down"));

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Archive without key",
        text: "hello",
        mailboxId: MAILBOX.id,
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      status: "sent_unarchived",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(insertOutboundMessage).not.toHaveBeenCalled();
    expect(insertSendLog.mock.calls[0]?.[1]).toMatchObject({
      status: "sent_unarchived",
      providerId: "cfes_msg_1",
    });
    expect(transitionSendAttempt).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ from: "pending", to: "sent_unarchived" }),
    );
  });

  it.each([
    ["no provisioned mailbox", [], MAILBOX.id],
    ["unowned mailbox", [MAILBOX], "mbx_not_owned"],
  ])(
    "uses mailbox_forbidden for %s",
    async (_label, availableMailboxes, mailboxId) => {
      getSendableMailboxes.mockResolvedValue(availableMailboxes);
      const fetchMock = stubRelay(relayOk());

      const res = await makeApp().fetch(
        postBody({
          to: [{ address: "bob@example.com" }],
          subject: "Mailbox error",
          text: "hello",
          mailboxId,
        }),
        makeEnv(),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "mailbox_forbidden" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("uses recipient_suppressed for a suppressed relay status", async () => {
    const fetchMock = stubRelay(relayOk("suppressed"));

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "blocked@example.com" }],
        subject: "Suppressed recipient",
        text: "hello",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "recipient_suppressed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses relay_unavailable for a relay transport error", async () => {
    const fetchMock = stubRelay(
      () => new Response("relay down", { status: 500 }),
    );

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "bob@example.com" }],
        subject: "Relay unavailable",
        text: "hello",
        mailboxId: MAILBOX.id,
      }),
      makeEnv(),
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "relay_unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves reply_all_no_recipients when Reply All removes every recipient", async () => {
    getThread.mockResolvedValue({
      ...threadWith("<source@example.com>", null),
      messages: [
        {
          ...threadWith("<source@example.com>", null).messages[0],
          from_address: MAILBOX.address,
          to_addresses: JSON.stringify([MAILBOX.address]),
          cc_addresses: JSON.stringify([]),
          bcc_addresses: JSON.stringify([]),
        },
      ],
    });
    const fetchMock = stubRelay(relayOk());

    const res = await makeApp().fetch(
      postBody({
        to: [{ address: "client-controlled@example.com" }],
        subject: "Re: empty Reply All",
        text: "reply",
        threadId: "thr_1",
        mailboxId: MAILBOX.id,
        replyMode: "reply-all",
        bccProvenance: "known-empty",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "reply_all_no_recipients" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(insertOutboundMessage).not.toHaveBeenCalled();
    expect(insertSendLog).not.toHaveBeenCalled();
  });
});
