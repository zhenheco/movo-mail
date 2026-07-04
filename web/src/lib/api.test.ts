/**
 * Pure-function tests for the web API client + compose/format helpers.
 *
 * These need no DOM: they cover query building, error mapping, recipient
 * parsing, reply pre-fill (threading), and SendRequest assembly — the logic the
 * UI relies on before any network call. A fetch double exercises the success and
 * error paths of the client without a real network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  buildQuery,
  createAdminMailbox,
  fetchSendableMailboxes,
  fetchMailboxes,
  fetchMe,
  fetchThreads,
  friendlyStatusMessage,
  searchMessages,
  sendMessage,
} from "./api";
import {
  isLikelyEmail,
  parseAddresses,
  parseRecipientInput,
  replySubject,
} from "./format";
import {
  buildSendRequest,
  bytesToBase64,
  estimatedBase64Length,
  replyDraft,
} from "./compose";
import type { MessageWithAttachments } from "./types";

// ── buildQuery ──────────────────────────────────────────────────────────────
describe("buildQuery", () => {
  it("omits null/undefined/empty values and url-encodes", () => {
    expect(buildQuery({ q: "a b", mailbox: "m1", empty: "", missing: undefined }))
      .toBe("?q=a+b&mailbox=m1");
  });
  it("returns an empty string when nothing is set", () => {
    expect(buildQuery({ a: null, b: undefined })).toBe("");
  });
});

// ── friendlyStatusMessage ────────────────────────────────────────────────────
describe("friendlyStatusMessage", () => {
  it("maps auth, not-found, rate-limit and server errors", () => {
    expect(friendlyStatusMessage(403)).toMatch(/access/i);
    expect(friendlyStatusMessage(404)).toMatch(/find/i);
    expect(friendlyStatusMessage(429)).toMatch(/too many/i);
    expect(friendlyStatusMessage(500)).toMatch(/server/i);
  });
});

// ── format helpers ───────────────────────────────────────────────────────────
describe("format helpers", () => {
  it("parses JSON address arrays and bare/comma values", () => {
    expect(parseAddresses('["a@x.com","b@y.com"]')).toEqual(["a@x.com", "b@y.com"]);
    expect(parseAddresses("a@x.com, b@y.com")).toEqual(["a@x.com", "b@y.com"]);
    expect(parseAddresses(null)).toEqual([]);
  });
  it("parses recipient input into address objects", () => {
    expect(parseRecipientInput("a@x.com; b@y.com ,")).toEqual([
      { address: "a@x.com" },
      { address: "b@y.com" },
    ]);
  });
  it("validates emails", () => {
    expect(isLikelyEmail("a@x.com")).toBe(true);
    expect(isLikelyEmail("nope")).toBe(false);
  });
  it("does not double-prefix Re:", () => {
    expect(replySubject("Hello")).toBe("Re: Hello");
    expect(replySubject("Re: Hello")).toBe("Re: Hello");
    expect(replySubject(null)).toBe("Re:");
  });
});

// ── compose: reply pre-fill + SendRequest assembly ───────────────────────────
function fakeMessage(): MessageWithAttachments {
  return {
    id: "msg-1",
    thread_id: "thr-1",
    mailbox_id: "mb-1",
    message_id: "<orig@movo.com.my>",
    in_reply_to: null,
    references: "<root@movo.com.my>",
    direction: "inbound",
    from_address: "client@example.com",
    from_name: "A Client",
    to_addresses: '["me@movo.com.my"]',
    cc_addresses: null,
    bcc_addresses: null,
    subject: "Invoice",
    snippet: "hi",
    text_body: "Please send the invoice.",
    html_body: null,
    r2_raw_key: null,
    has_attachments: 0,
    unread: 1,
    date: 1_700_000_000_000,
    created_at: 1_700_000_000_000,
    attachments: [],
  };
}

describe("compose helpers", () => {
  it("replyDraft pre-fills To, Re-subject, threading + history", () => {
    const draft = replyDraft(fakeMessage());
    expect(draft.to).toBe("client@example.com");
    expect(draft.subject).toBe("Re: Invoice");
    expect(draft.threadId).toBe("thr-1");
    expect(draft.inReplyTo).toBe("<orig@movo.com.my>");
    expect(draft.references).toBe("<root@movo.com.my> <orig@movo.com.my>");
    expect(draft.history?.[0]?.text).toBe("Please send the invoice.");
  });

  it("buildSendRequest attaches threading headers only when present", () => {
    const withThread = buildSendRequest({
      fromAddress: "me@movo.com.my",
      to: [{ address: "client@example.com" }],
      subject: "  Re: Invoice  ",
      text: "Here it is.",
      threadId: "thr-1",
      mailboxId: "mb-1",
      inReplyTo: "<orig@movo.com.my>",
      references: "<root@movo.com.my>",
    });
    expect(withThread.subject).toBe("Re: Invoice");
    expect(withThread.headers?.["In-Reply-To"]).toBe("<orig@movo.com.my>");
    expect(withThread.headers?.["References"]).toBe("<root@movo.com.my>");

    const plain = buildSendRequest({
      fromAddress: "me@movo.com.my",
      to: [{ address: "client@example.com" }],
      subject: "Hi",
      text: "Hello",
    });
    expect(plain.headers).toBeUndefined();
    expect(plain.threadId).toBeUndefined();
  });

  it("buildSendRequest carries outbound attachments", () => {
    const req = buildSendRequest({
      fromAddress: "me@movo.com.my",
      to: [{ address: "client@example.com" }],
      subject: "Invoice",
      text: "Attached.",
      attachments: [
        {
          filename: "invoice.txt",
          contentType: "text/plain",
          contentBase64: "aGVsbG8=",
        },
      ],
    });

    expect(req.attachments).toEqual([
      {
        filename: "invoice.txt",
        contentType: "text/plain",
        contentBase64: "aGVsbG8=",
      },
    ]);
  });

  it("bytesToBase64 encodes binary attachment bytes", () => {
    expect(bytesToBase64(new Uint8Array([0, 255, 16, 32]))).toBe("AP8QIA==");
  });

  it("estimatedBase64Length matches base64 padding growth", () => {
    expect(estimatedBase64Length(0)).toBe(0);
    expect(estimatedBase64Length(1)).toBe(4);
    expect(estimatedBase64Length(2)).toBe(4);
    expect(estimatedBase64Length(3)).toBe(4);
    expect(estimatedBase64Length(4)).toBe(8);
  });
});

// ── client fetch behaviour (success + error mapping) ─────────────────────────
describe("api client fetch", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("fetchMailboxes unwraps the mailboxes array on 200", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          mailboxes: [
            { id: "mb-1", address: "me@movo.com.my", displayName: "Me" },
            { id: "mb-2", address: "ops@movo.com.my", displayName: null },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const boxes = await fetchMailboxes();
    expect(boxes.map((m) => m.id)).toEqual(["mb-1", "mb-2"]);
    expect(boxes[0]?.address).toBe("me@movo.com.my");
    expect(boxes[1]?.displayName).toBeNull();
    // Hits the mailbox-listing endpoint under /api.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mailboxes",
      expect.anything(),
    );
  });

  it("fetchSendableMailboxes unwraps owned and shared mailboxes from the sendable endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          mailboxes: [
            {
              id: "mb-owned",
              address: "me@movo.com.my",
              displayName: "Me",
              kind: "personal",
            },
            {
              id: "mb-shared",
              address: "service@movo.com.my",
              displayName: "Service",
              kind: "shared",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const boxes = await fetchSendableMailboxes();

    expect(boxes.map((m) => [m.id, m.kind])).toEqual([
      ["mb-owned", "personal"],
      ["mb-shared", "shared"],
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mailboxes/sendable",
      expect.anything(),
    );
  });

  it("fetchMailboxes throws ApiError on a server error", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Unable to load mailboxes." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    await expect(fetchMailboxes()).rejects.toBeInstanceOf(ApiError);
    await expect(fetchMailboxes()).rejects.toMatchObject({ status: 500 });
  });

  it("fetchThreads returns the threads array on 200", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ threads: [{ id: "t1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const threads = await fetchThreads("mb-1");
    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe("t1");
  });

  it("throws ApiError with server message on non-2xx", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    await expect(searchMessages("x", "mb-1")).rejects.toBeInstanceOf(ApiError);
    await expect(searchMessages("x", "mb-1")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("maps a network failure to a friendly ApiError(status 0)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(
      sendMessage(
        {
          from: { address: "me@movo.com.my" },
          to: [{ address: "x@y.com" }],
          subject: "s",
          text: "t",
        },
        "retry-key-1",
      ),
    ).rejects.toMatchObject({ status: 0 });
  });

  it("sendMessage returns the flat server result and sends an Idempotency-Key", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          id: "cfes_1",
          status: "sent",
          messageId: "m1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await sendMessage(
      {
        from: { address: "me@movo.com.my" },
        to: [{ address: "x@y.com" }],
        subject: "s",
        text: "t",
      },
      "k1",
    );

    expect(result.id).toBe("cfes_1");
    expect(result.status).toBe("sent");
    const call = fetchMock.mock.calls[0] as unknown as
      | [string, RequestInit]
      | undefined;
    expect(call?.[0]).toBe("/api/send");
    expect(call?.[1].headers).toMatchObject({ "Idempotency-Key": "k1" });
  });
});

// ── identity probe (fetchMe) ─────────────────────────────────────────────────
describe("fetchMe", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("reads the server's FLAT { email, isAdmin } body (admin)", async () => {
    // Mirror the real server shape from src/api/me.ts: a flat object, NOT { me }.
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ email: "boss@movo.com.my", isAdmin: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const me = await fetchMe();
    expect(me.email).toBe("boss@movo.com.my");
    expect(me.isAdmin).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/me", expect.anything());
  });

  it("reports isAdmin: false for a non-admin", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ email: "alice@movo.com.my", isAdmin: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const me = await fetchMe();
    expect(me.email).toBe("alice@movo.com.my");
    expect(me.isAdmin).toBe(false);
  });

  it("throws ApiError on a server error", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Unable to load your account." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    await expect(fetchMe()).rejects.toBeInstanceOf(ApiError);
    await expect(fetchMe()).rejects.toMatchObject({ status: 500 });
  });
});

// ── admin mailbox creation ───────────────────────────────────────────────────
describe("createAdminMailbox", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("POSTs the body as JSON to /api/admin/mailboxes and returns the created id", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "mb-9" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await createAdminMailbox({
      address: "sales@movo.com.my",
      ownerEmail: "owner@movo.com.my",
      displayName: "Sales",
    });

    expect(result.id).toBe("mb-9");
    // Correct path.
    const call = fetchMock.mock.calls[0] as unknown as
      | [string, RequestInit]
      | undefined;
    expect(call).toBeDefined();
    const path = call?.[0];
    const init = call?.[1];
    expect(path).toBe("/api/admin/mailboxes");
    // Correct method + JSON body.
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      address: "sales@movo.com.my",
      ownerEmail: "owner@movo.com.my",
      displayName: "Sales",
    });
    // JSON content-type is set when a body is present.
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
    });
  });

  it("surfaces a 409 duplicate as an ApiError carrying the server message", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Address already exists." }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const promise = createAdminMailbox({
      address: "dup@movo.com.my",
      ownerEmail: "owner@movo.com.my",
    });
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 409 });
    // The server's reason is appended to the friendly message.
    await expect(promise).rejects.toThrow(/already exists/i);
  });
});
