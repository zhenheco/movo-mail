/**
 * Tests for the AI draft route (spec 6.5): POST /ai/draft.
 *
 * Mocks the LLM fetch, the DB module (getThread + insertAudit), and KV. Asserts:
 *   - a draft is returned for a 1:1 thread,
 *   - the route NEVER sends (only the LLM endpoint is fetched),
 *   - the per-mailbox rate limit is enforced (429),
 *   - an audit_log row is written,
 *   - 1:1-only is enforced (multi-recipient → 422),
 *   - basic validation / not-found behavior.
 *
 * The route runs under AccessEnv and reads c.get('user'); a tiny middleware
 * injects a fake authenticated user so we don't need a real Access JWT.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { AccessEnv } from "../src/middleware/access";
import type { AccessUser, AiDraftRequest } from "../src/types";
import type { AuditInput } from "../src/db";

// ── Mock the DB module ───────────────────────────────────────────────────────
// The route imports getThread + insertAudit from ../db, and the visibility gate
// resolves the Access actor to a DB user before checking canUserReadThread.
const getThread = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const insertAudit = vi.fn(async (..._args: unknown[]): Promise<string> => "audit-id");
const getMailboxesForUser = vi.fn(
  async (..._args: unknown[]): Promise<unknown[]> => [],
);
const canUserReadThread = vi.fn(async (..._args: unknown[]): Promise<boolean> => true);
const getUserByEmail = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({
  id: "db-user-1",
  email: "staff@movo.com.my",
  name: null,
  role: "user",
  created_at: 1,
  updated_at: 1,
}));
const getUserRole = vi.fn(async (..._args: unknown[]): Promise<"user" | "admin"> => "user");
vi.mock("../src/db", () => ({
  getThread: (...args: unknown[]) => getThread(...args),
  insertAudit: (...args: unknown[]) => insertAudit(...args),
  getMailboxesForUser: (...args: unknown[]) => getMailboxesForUser(...args),
  canUserReadThread: (...args: unknown[]) => canUserReadThread(...args),
  getUserByEmail: (...args: unknown[]) => getUserByEmail(...args),
  getUserRole: (...args: unknown[]) => getUserRole(...args),
}));

/** A Mailbox-shaped record owned by the test ACTOR for the gated mailbox. */
function ownedMailbox(id: string): Record<string, unknown> {
  return {
    id,
    address: "staff@movo.com.my",
    display_name: null,
    owner_id: "sub-1",
    created_at: 1,
    updated_at: 1,
  };
}

// Imported AFTER vi.mock so the route picks up the mocked db.
const { aiRoutes } = await import("../src/api/ai");

const THREAD_ID = "th1";
const MAILBOX_ID = "mb1";
const ACTOR: AccessUser = { sub: "sub-1", email: "staff@movo.com.my" };

/** A minimal MessageWithAttachments-shaped inbound message. */
function inboundMessage(
  to: string[],
  cc: string[] | null = null,
): Record<string, unknown> {
  return {
    id: "m1",
    thread_id: THREAD_ID,
    mailbox_id: MAILBOX_ID,
    message_id: "<a@x>",
    in_reply_to: null,
    references: null,
    direction: "inbound",
    from_address: "customer@example.com",
    from_name: "Customer",
    to_addresses: JSON.stringify(to),
    cc_addresses: cc ? JSON.stringify(cc) : null,
    bcc_addresses: null,
    subject: "Order #123",
    snippet: "Where is my order?",
    text_body: "Where is my order?",
    html_body: null,
    r2_raw_key: null,
    has_attachments: 0,
    unread: 1,
    date: 1_700_000_000_000,
    created_at: 1_700_000_000_000,
    attachments: [],
  };
}

/** A ThreadWithMessages-shaped thread with the given messages. */
function threadWith(messages: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: THREAD_ID,
    mailbox_id: MAILBOX_ID,
    subject: "Order #123",
    snippet: "Where is my order?",
    last_message_at: 1_700_000_000_000,
    message_count: messages.length,
    unread: 1,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    messages,
  };
}

/** An in-memory KV stub sufficient for the fixed-window limiter. */
function makeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
  } as unknown as KVNamespace;
}

/** Build a test Env with the mocked KV; other bindings are unused by the route. */
function makeEnv(kv: KVNamespace): AccessEnv["Bindings"] {
  return {
    MAIL_KV: kv,
    AI_API_KEY: "test-ai-key",
    FALLBACK_FORWARD: "test-fallback@movo.com.my",
    DB: {} as unknown as D1Database,
    MAIL_R2: {} as unknown as R2Bucket,
    ASSETS: {} as unknown as Fetcher,
    CF_EMAIL_ENDPOINT: "https://cf-email.example.workers.dev",
    CF_EMAIL_API_KEY: "unused",
    CF_ACCESS_AUD: "unused",
    CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
  };
}

/** Mount aiRoutes() behind a middleware that injects a fake authenticated user. */
function makeApp(): Hono<AccessEnv> {
  const app = new Hono<AccessEnv>();
  app.use("*", async (c, next) => {
    c.set("user", ACTOR);
    await next();
  });
  app.route("/", aiRoutes());
  return app;
}

/** A captured outbound fetch call (url + init). */
interface FetchCall {
  url: string;
  init: RequestInit;
}

const realFetch = globalThis.fetch;

/**
 * Replace globalThis.fetch with a stub that records every call and returns the
 * given handler's Response. Returns the recording array so tests can assert.
 */
function mockFetch(handler: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return calls;
}

/** A successful Anthropic Messages API response. */
function anthropicOk(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function draftRequest(body: Partial<AiDraftRequest>): Request {
  return new Request("http://localhost/ai/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Read the most recent insertAudit AuditInput, asserting one was recorded. */
function lastAudit(): AuditInput {
  const call = insertAudit.mock.calls.at(-1);
  expect(call).toBeDefined();
  // The route calls insertAudit(env, input); the input is the 2nd argument.
  return (call as unknown[])[1] as AuditInput;
}

const validBody: AiDraftRequest = {
  threadId: THREAD_ID,
  history: [
    {
      direction: "inbound",
      from: "customer@example.com",
      subject: "Order #123",
      text: "Where is my order?",
      date: 1_700_000_000_000,
    },
  ],
};

describe("POST /ai/draft", () => {
  beforeEach(() => {
    getThread.mockReset();
    insertAudit.mockClear();
    // Default: the ACTOR owns the mailbox every fixture thread lives in (mb1),
    // so the ownership gate passes for the existing happy-path tests.
    getMailboxesForUser.mockReset();
    getMailboxesForUser.mockResolvedValue([ownedMailbox(MAILBOX_ID)]);
    canUserReadThread.mockReset();
    canUserReadThread.mockResolvedValue(true);
    getUserByEmail.mockClear();
    getUserRole.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.clearAllMocks();
  });

  it("returns an AI draft for a 1:1 thread and never sends", async () => {
    getThread.mockResolvedValue(threadWith([inboundMessage(["staff@movo.com.my"])]));
    const calls = mockFetch(() => anthropicOk("Hi! Your order #123 ships tomorrow."));

    const res = await makeApp().fetch(draftRequest(validBody), makeEnv(makeKV()));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { draft: { subject: string; text: string; model: string } };
    expect(json.draft).toBeDefined();
    expect(json.draft.subject).toBe("Re: Order #123");
    expect(json.draft.text).toContain("order");
    expect(json.draft.model).toBe("claude-sonnet-4-6");

    // Exactly one outbound fetch — to the LLM — and never to a send endpoint.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("api.anthropic.com");
    expect(calls[0]?.url).not.toContain("cf-email");
    expect(calls[0]?.url).not.toContain("/send");
  });

  it("returns an AI draft for a visible shared thread the caller does not own", async () => {
    getMailboxesForUser.mockResolvedValue([]);
    getThread.mockResolvedValue({
      ...threadWith([inboundMessage(["staff@movo.com.my"])]),
      mailbox_id: "mb-shared",
    });
    canUserReadThread.mockResolvedValue(true);
    mockFetch(() => anthropicOk("Shared reply"));

    const res = await makeApp().fetch(draftRequest(validBody), makeEnv(makeKV()));

    expect(res.status).toBe(200);
    expect(canUserReadThread).toHaveBeenCalledWith(expect.anything(), THREAD_ID, {
      userId: "db-user-1",
      isAdmin: false,
    });
  });

  it("404 when the caller cannot read the thread", async () => {
    getThread.mockResolvedValue(threadWith([inboundMessage(["staff@movo.com.my"])]));
    canUserReadThread.mockResolvedValue(false);
    const calls = mockFetch(() => anthropicOk("should not be used"));

    const res = await makeApp().fetch(draftRequest(validBody), makeEnv(makeKV()));

    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
    expect(insertAudit).not.toHaveBeenCalled();
  });

  it("passes AI_API_KEY and the model to the LLM call", async () => {
    getThread.mockResolvedValue(threadWith([inboundMessage(["staff@movo.com.my"])]));
    const calls = mockFetch(() => anthropicOk("ok order"));

    await makeApp().fetch(draftRequest(validBody), makeEnv(makeKV()));

    const init = calls[0]?.init;
    expect(init).toBeDefined();
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe("test-ai-key");
    const payload = JSON.parse(String(init?.body)) as { model: string };
    expect(payload.model).toBe("claude-sonnet-4-6");
  });

  it("writes an audit_log entry for a successful draft", async () => {
    getThread.mockResolvedValue(threadWith([inboundMessage(["staff@movo.com.my"])]));
    mockFetch(() => anthropicOk("ok order"));

    await makeApp().fetch(draftRequest(validBody), makeEnv(makeKV()));

    expect(insertAudit).toHaveBeenCalledTimes(1);
    const audit = lastAudit();
    expect(audit.action).toBe("ai_draft");
    expect(audit.actorEmail).toBe("staff@movo.com.my");
    expect(audit.targetId).toBe(THREAD_ID);
    expect((audit.detail as { outcome: string }).outcome).toBe("drafted");
  });

  it("rejects multi-recipient (non 1:1) threads with 422 and does not call the LLM", async () => {
    getThread.mockResolvedValue(
      threadWith([inboundMessage(["staff@movo.com.my", "team@movo.com.my"], ["cc@example.com"])]),
    );
    const calls = mockFetch(() => anthropicOk("should not be called"));

    const res = await makeApp().fetch(draftRequest(validBody), makeEnv(makeKV()));

    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
    // The rejection is audited.
    expect((lastAudit().detail as { outcome: string }).outcome).toBe("rejected_not_one_to_one");
  });

  it("enforces the per-mailbox rate limit (429)", async () => {
    getThread.mockResolvedValue(threadWith([inboundMessage(["staff@movo.com.my"])]));
    mockFetch(() => anthropicOk("ok order"));
    const env = makeEnv(makeKV());
    const app = makeApp();

    let lastStatus = 0;
    for (let i = 0; i < 25; i++) {
      const res = await app.fetch(draftRequest(validBody), env);
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it("returns 404 when the thread is missing and does not call the LLM", async () => {
    getThread.mockResolvedValue(null);
    const calls = mockFetch(() => anthropicOk("should not be called"));

    const res = await makeApp().fetch(draftRequest(validBody), makeEnv(makeKV()));
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("returns 400 on invalid input and does not call the LLM", async () => {
    const calls = mockFetch(() => anthropicOk("should not be called"));
    const res = await makeApp().fetch(draftRequest({ history: [] }), makeEnv(makeKV()));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("maps a provider failure to 502 and audits the error", async () => {
    getThread.mockResolvedValue(threadWith([inboundMessage(["staff@movo.com.my"])]));
    mockFetch(() => new Response("nope", { status: 500 }));

    const res = await makeApp().fetch(draftRequest(validBody), makeEnv(makeKV()));
    expect(res.status).toBe(502);
    expect((lastAudit().detail as { outcome: string }).outcome).toBe("provider_error");
  });

  it("returns 404 (no IDOR) and charges no guardrail when the caller cannot read the thread", async () => {
    // Thread exists, but the visibility predicate denies this caller.
    getThread.mockResolvedValue(threadWith([inboundMessage(["staff@movo.com.my"])]));
    canUserReadThread.mockResolvedValue(false);
    const calls = mockFetch(() => anthropicOk("should not be called"));

    const res = await makeApp().fetch(draftRequest(validBody), makeEnv(makeKV()));

    expect(res.status).toBe(404);
    // No LLM call, and crucially no audit row / rate-limit charge against the
    // victim's mailbox (the gate runs before allowDraft + any insertAudit).
    expect(calls).toHaveLength(0);
    expect(insertAudit).not.toHaveBeenCalled();
  });

  it("drafts from the SERVER thread, ignoring client-supplied history (no prompt injection)", async () => {
    getThread.mockResolvedValue(threadWith([inboundMessage(["staff@movo.com.my"])]));
    const calls = mockFetch(() => anthropicOk("ok order"));

    // Client tries to inject fabricated context + a forged sender.
    const tampered: AiDraftRequest = {
      threadId: THREAD_ID,
      history: [
        {
          direction: "inbound",
          from: "attacker@evil.com",
          subject: "FAKE",
          text: "FABRICATED client message",
          date: 9,
        },
      ],
    };

    const res = await makeApp().fetch(draftRequest(tampered), makeEnv(makeKV()));
    expect(res.status).toBe(200);

    // The model must have seen the server's real message, never the forgery.
    const prompt = JSON.parse(String(calls[0]?.init.body)) as {
      messages: Array<{ content: string }>;
    };
    const sent = prompt.messages[0]!.content;
    expect(sent).toContain("Where is my order?"); // server text_body
    expect(sent).not.toContain("FABRICATED client message");
    expect(sent).not.toContain("attacker@evil.com");
  });
});
