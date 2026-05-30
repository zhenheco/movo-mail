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
import { buildSendRequest, replyDraft } from "./compose";
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
      sendMessage({
        from: { address: "me@movo.com.my" },
        to: [{ address: "x@y.com" }],
        subject: "s",
        text: "t",
      }),
    ).rejects.toMatchObject({ status: 0 });
  });
});
