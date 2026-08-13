import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_COUNT_ERROR,
  ATTACHMENT_PAYLOAD_ERROR,
  MAX_ATTACHMENT_PAYLOAD_BYTES,
  MOVO_SEND_CONTRACT_VERSION,
  UNAVAILABLE_BCC_CONFIRMATION,
  buildSendRequest,
  replyAllDraft,
  validateAttachmentSelection,
} from "./compose";
import type { BuildSendArgs } from "./compose";
import type { MessageWithAttachments } from "./types";

function message(
  overrides: Partial<MessageWithAttachments> = {},
): MessageWithAttachments {
  return {
    id: "message-1",
    thread_id: "thread-1",
    mailbox_id: "mailbox-1",
    message_id: "<message-1@example.com>",
    in_reply_to: null,
    references: "<root@example.com>",
    direction: "inbound",
    from_address: "sender@example.com",
    from_name: "Sender",
    to_addresses: JSON.stringify([
      "me@movo.com.my",
      "team@example.com",
      "TEAM@example.com",
    ]),
    cc_addresses: JSON.stringify(["copy@example.com", "sender@example.com"]),
    bcc_addresses: JSON.stringify(["hidden@example.com", "team@example.com"]),
    subject: "Invoice",
    snippet: "Please review",
    text_body: "Please review",
    html_body: null,
    r2_raw_key: null,
    has_attachments: 0,
    unread: 0,
    date: 1_700_000_000_000,
    created_at: 1_700_000_000_000,
    attachments: [],
    ...overrides,
  };
}

describe("Reply All compose semantics", () => {
  it("keeps visible buckets, carries authoritative Bcc, removes self, and deduplicates case-insensitively", () => {
    const draft = replyAllDraft(message(), ["ME@movo.com.my"]);

    expect(draft.to).toBe("sender@example.com, team@example.com");
    expect(draft.cc).toBe("copy@example.com");
    expect(draft.bcc).toBe("hidden@example.com");
    expect(draft.mode).toBe("reply-all");
    expect(draft.bccProvenance).toBe("known-nonempty");
  });

  it("marks missing original Bcc as unavailable instead of silently sending visible recipients only", () => {
    const draft = replyAllDraft(message({ bcc_addresses: null }), [
      "me@movo.com.my",
    ]);

    expect(draft.to).toContain("sender@example.com");
    expect(draft.cc).toBe("copy@example.com");
    expect(draft.bcc).toBe("");
    expect(draft.bccProvenance).toBe("unavailable");
    expect(draft.bccConfirmation).toBeUndefined();
  });
});

describe("versioned Movo send request", () => {
  it("omits unavailable-Bcc confirmation until supplied, then serializes typed Bcc exactly", () => {
    const args = {
      fromAddress: "me@movo.com.my",
      to: [{ address: "sender@example.com" }],
      cc: [{ address: "copy@example.com" }],
      bcc: [{ address: "manual-hidden@example.com", name: "Manual Hidden" }],
      subject: "Re: Invoice",
      text: "Attached.",
      mode: "reply-all",
      bccProvenance: "unavailable",
      idempotencyKey: "send-key-1",
    } satisfies BuildSendArgs;
    const withoutConfirmation = buildSendRequest(args);

    expect(withoutConfirmation).not.toHaveProperty("bccConfirmation");
    expect(withoutConfirmation.bcc).toEqual(args.bcc);
    expect(withoutConfirmation.bccProvenance).toBe("unavailable");

    const withConfirmation = buildSendRequest({
      ...args,
      bccConfirmation: UNAVAILABLE_BCC_CONFIRMATION,
    });

    expect(withConfirmation).toMatchObject({
      contract_version: MOVO_SEND_CONTRACT_VERSION,
      cc: [{ address: "copy@example.com" }],
      bcc: args.bcc,
      replyMode: "reply-all",
      bccProvenance: "unavailable",
      bccConfirmation: UNAVAILABLE_BCC_CONFIRMATION,
      idempotencyKey: "send-key-1",
    });
  });
});

describe("compose attachment boundaries", () => {
  it("accepts exactly 10 files and rejects the 11th atomically", () => {
    expect(validateAttachmentSelection(0, new Array(10).fill(1))).toBeNull();
    expect(validateAttachmentSelection(0, new Array(11).fill(1))).toBe(
      ATTACHMENT_COUNT_ERROR,
    );
    expect(validateAttachmentSelection(10, [1])).toBe(ATTACHMENT_COUNT_ERROR);
  });

  it("accepts the exact Base64 payload boundary and rejects the next valid quartet", () => {
    const exact = MAX_ATTACHMENT_PAYLOAD_BYTES;
    expect(validateAttachmentSelection(0, [exact])).toBeNull();
    expect(validateAttachmentSelection(0, [exact + 4])).toBe(
      ATTACHMENT_PAYLOAD_ERROR,
    );
    expect(validateAttachmentSelection(9, [1], exact)).toBe(
      ATTACHMENT_PAYLOAD_ERROR,
    );
  });
});
