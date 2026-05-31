import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, Mailbox, ParsedInbound } from "../src/types";

/**
 * Inbound Email Worker tests.
 *
 * These feed a raw .eml into handleInbound and assert that:
 *  - the destination mailbox is resolved via db.getMailboxByAddress
 *  - the raw .eml is archived to R2 at msg/{id}.eml
 *  - each attachment is archived to R2 at att/{id}/{n}
 *  - the normalized message is indexed via db.insertInboundMessage with the
 *    correct fields (from / subject / threading / snippet / has_attachment)
 *
 * src/db and R2 are mocked so this runs in the plain node pool (no workerd).
 */

// ── Mock the db module so we can assert the persisted shape ──────────────────
vi.mock("../src/db", () => ({
  getMailboxByAddress: vi.fn(),
  insertInboundMessage: vi.fn(),
}));

import * as db from "../src/db";
import { handleInbound } from "../src/email/inbound";

// ── Helpers ──────────────────────────────────────────────────────────────────

const SAMPLE_MAILBOX: Mailbox = {
  id: "mbx-1",
  address: "support@movo.com.my",
  display_name: "Support",
  owner_id: null,
  created_at: 0,
  updated_at: 0,
};

/** Build a tiny in-memory R2 stub recording every put. */
function makeR2(): { bucket: R2Bucket; puts: Array<{ key: string; size: number }> } {
  const puts: Array<{ key: string; size: number }> = [];
  const bucket = {
    async put(key: string, value: ArrayBuffer | Uint8Array | ReadableStream | string) {
      let size = 0;
      if (typeof value === "string") size = value.length;
      else if (value instanceof Uint8Array) size = value.byteLength;
      else if (value instanceof ArrayBuffer) size = value.byteLength;
      puts.push({ key, size });
      return { key } as unknown as R2Object;
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
}

/** Construct a ForwardableEmailMessage-like object around a raw .eml string. */
function makeMessage(raw: string, to: string, from = "alice@example.com") {
  const bytes = new TextEncoder().encode(raw);
  return {
    from,
    to,
    rawSize: bytes.byteLength,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    headers: new Headers(),
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage;
}

function makeEnv(bucket: R2Bucket): Env {
  return {
    MAIL_R2: bucket,
    DB: {} as D1Database,
    MAIL_KV: {} as KVNamespace,
    ASSETS: {} as Fetcher,
    CF_EMAIL_ENDPOINT: "https://cf-email.example.workers.dev",
    CF_EMAIL_API_KEY: "test-key",
    CF_ACCESS_AUD: "aud",
    CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    AI_API_KEY: "ai-key",
    FALLBACK_FORWARD: "fallback@movo.com.my",
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PLAIN_EML = [
  "From: Alice <alice@example.com>",
  "To: support@movo.com.my",
  "Subject: Order question",
  "Message-ID: <root-123@example.com>",
  "Date: Fri, 30 May 2026 10:00:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello, I have a question about my order. Thanks!",
  "",
].join("\r\n");

const ATTACHMENT_EML = [
  "From: Bob <bob@example.com>",
  "To: support@movo.com.my",
  "Subject: Receipt attached",
  "Message-ID: <att-456@example.com>",
  "Date: Fri, 30 May 2026 11:00:00 +0000",
  'Content-Type: multipart/mixed; boundary="BOUNDARY"',
  "",
  "--BOUNDARY",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Please see the attached receipt.",
  "",
  "--BOUNDARY",
  'Content-Type: text/plain; name="receipt.txt"',
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="receipt.txt"',
  "",
  Buffer.from("RECEIPT BODY").toString("base64"),
  "",
  "--BOUNDARY--",
  "",
].join("\r\n");

const REPLY_EML = [
  "From: Alice <alice@example.com>",
  "To: support@movo.com.my",
  "Subject: Re: Order question",
  "Message-ID: <reply-789@example.com>",
  "In-Reply-To: <root-123@example.com>",
  "References: <root-123@example.com>",
  "Date: Fri, 30 May 2026 12:00:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Following up on my earlier question.",
  "",
].join("\r\n");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("handleInbound", () => {
  beforeEach(() => {
    vi.mocked(db.getMailboxByAddress).mockReset();
    vi.mocked(db.insertInboundMessage).mockReset();
    vi.mocked(db.getMailboxByAddress).mockResolvedValue(SAMPLE_MAILBOX);
    vi.mocked(db.insertInboundMessage).mockResolvedValue("msg-1");
  });

  it("resolves the mailbox from the envelope recipient", async () => {
    const { bucket } = makeR2();
    const env = makeEnv(bucket);
    const msg = makeMessage(PLAIN_EML, "support@movo.com.my");

    await handleInbound(msg, env);

    expect(db.getMailboxByAddress).toHaveBeenCalledWith(env, "support@movo.com.my");
  });

  it("archives the raw .eml to R2 under msg/{id}.eml and indexes the message", async () => {
    const { bucket, puts } = makeR2();
    const env = makeEnv(bucket);
    const msg = makeMessage(PLAIN_EML, "support@movo.com.my");

    await handleInbound(msg, env);

    expect(db.insertInboundMessage).toHaveBeenCalledTimes(1);
    const parsed = vi.mocked(db.insertInboundMessage).mock.calls[0]![1] as ParsedInbound;

    // raw .eml archived at msg/{id}.eml with a sane size
    const rawPut = puts.find((p) => /^msg\/[^/]+\.eml$/.test(p.key));
    expect(rawPut).toBeDefined();
    expect(rawPut!.size).toBeGreaterThan(0);

    // normalized fields
    expect(parsed.mailboxAddress).toBe("support@movo.com.my");
    expect(parsed.from.address).toBe("alice@example.com");
    expect(parsed.subject).toBe("Order question");
    expect(parsed.messageId).toBe("<root-123@example.com>");
    expect(parsed.inReplyTo).toBeNull();
    expect(parsed.references).toEqual([]);
    expect(parsed.snippet).toContain("Hello, I have a question");
    expect(parsed.attachments).toHaveLength(0);
    expect(parsed.date).toBe(Date.parse("Fri, 30 May 2026 10:00:00 +0000"));
  });

  it("stores attachment bytes to R2 under att/{id}/{n} and flags has_attachment", async () => {
    const { bucket, puts } = makeR2();
    const env = makeEnv(bucket);
    const msg = makeMessage(ATTACHMENT_EML, "support@movo.com.my", "bob@example.com");

    await handleInbound(msg, env);

    const parsed = vi.mocked(db.insertInboundMessage).mock.calls[0]![1] as ParsedInbound;
    expect(parsed.attachments.length).toBeGreaterThanOrEqual(1);
    expect(parsed.attachments[0]!.filename).toBe("receipt.txt");

    // attachment bytes archived at att/{id}/0 (shares the same id as the raw .eml)
    const rawPut = puts.find((p) => /^msg\/[^/]+\.eml$/.test(p.key));
    const id = rawPut!.key.slice("msg/".length, -".eml".length);
    const attPut = puts.find((p) => p.key === `att/${id}/0`);
    expect(attPut).toBeDefined();
    expect(attPut!.size).toBeGreaterThan(0);
  });

  it("threads ONE id through R2 archival and the D1 index (no orphaned objects)", async () => {
    // The id used to archive the raw .eml MUST be the same id passed to
    // insertInboundMessage (3rd arg), since the DB derives r2_raw_key +
    // attachment r2_key from it. Different ids = stored row points at R2
    // objects that do not exist.
    const { bucket, puts } = makeR2();
    const env = makeEnv(bucket);
    const msg = makeMessage(PLAIN_EML, "support@movo.com.my");

    await handleInbound(msg, env);

    const passedId = vi.mocked(db.insertInboundMessage).mock.calls[0]![2] as
      | string
      | undefined;
    expect(typeof passedId).toBe("string");
    expect(passedId).toBeTruthy();
    // The raw .eml was archived under exactly that id (so msg/<id>.eml resolves).
    expect(puts.some((p) => p.key === `msg/${passedId}.eml`)).toBe(true);
  });

  it("carries threading headers (In-Reply-To / References) for replies", async () => {
    const { bucket } = makeR2();
    const env = makeEnv(bucket);
    const msg = makeMessage(REPLY_EML, "support@movo.com.my");

    await handleInbound(msg, env);

    const parsed = vi.mocked(db.insertInboundMessage).mock.calls[0]![1] as ParsedInbound;
    expect(parsed.messageId).toBe("<reply-789@example.com>");
    expect(parsed.inReplyTo).toBe("<root-123@example.com>");
    expect(parsed.references).toEqual(["<root-123@example.com>"]);
  });

  it("does not throw and skips indexing when the mailbox is unknown", async () => {
    vi.mocked(db.getMailboxByAddress).mockResolvedValue(null);
    const { bucket } = makeR2();
    const env = makeEnv(bucket);
    const msg = makeMessage(PLAIN_EML, "nobody@movo.com.my");

    await expect(handleInbound(msg, env)).resolves.toBeUndefined();
    expect(db.insertInboundMessage).not.toHaveBeenCalled();
  });

  it("never throws out of the handler even if R2 fails", async () => {
    const env = makeEnv({
      put: vi.fn().mockRejectedValue(new Error("R2 down")),
    } as unknown as R2Bucket);
    const msg = makeMessage(PLAIN_EML, "support@movo.com.my");

    await expect(handleInbound(msg, env)).resolves.toBeUndefined();
    expect(db.insertInboundMessage).not.toHaveBeenCalled();
  });
});
