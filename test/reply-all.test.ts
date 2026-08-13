import { describe, expect, it } from "vitest";
import type { EmailAddress } from "../src/types";
import {
  buildReplyAllRecipients,
  REPLY_ALL_BCC_CONFIRMATION,
  type ReplyAllInput,
} from "../src/lib/reply-all";

const address = (value: string, name?: string): EmailAddress =>
  name ? { address: value, name } : { address: value };

function input(overrides: Partial<ReplyAllInput> = {}): ReplyAllInput {
  return {
    from: address("sender@example.com", "Sender"),
    to: [address("owner@movo.com.my"), address("to@example.com")],
    cc: [address("cc@example.com")],
    bcc: [address("hidden@example.com")],
    bccProvenance: "known-nonempty",
    ...overrides,
  };
}

describe("buildReplyAllRecipients", () => {
  it("keeps recipient buckets, removes self, and de-duplicates across visible and Bcc", () => {
    const result = buildReplyAllRecipients(input({
      to: [
        address("owner@movo.com.my"),
        address("To@example.com", "Visible first"),
        address("duplicate@example.com"),
      ],
      cc: [
        address("cc@example.com"),
        address("DUPLICATE@example.com", "Bcc must lose"),
        address("owner@movo.com.my"),
      ],
      bcc: [
        address("hidden@example.com"),
        address("CC@example.com"),
        address("bcc-only@example.com"),
      ],
    }), ["owner@movo.com.my"]);

    expect(result).toEqual({
      ok: true,
      to: [
        address("sender@example.com", "Sender"),
        address("To@example.com", "Visible first"),
        address("duplicate@example.com"),
      ],
      cc: [address("cc@example.com")],
      bcc: [address("hidden@example.com"), address("bcc-only@example.com")],
    });
  });

  it("promotes the first remaining visible recipient when self-removal empties To", () => {
    const result = buildReplyAllRecipients(
      input({
        from: address("owner@movo.com.my"),
        to: [address("owner@movo.com.my")],
        cc: [address("cc@example.com"), address("later@example.com")],
        bcc: [address("hidden@example.com")],
      }),
      ["OWNER@movo.com.my"],
    );

    expect(result).toEqual({
      ok: true,
      to: [address("cc@example.com")],
      cc: [address("later@example.com")],
      bcc: [address("hidden@example.com")],
    });
  });

  it("distinguishes known-empty Bcc from unavailable Bcc", () => {
    const knownEmpty = buildReplyAllRecipients(
      input({ bcc: [], bccProvenance: "known-empty" }),
      [],
    );
    expect(knownEmpty).toMatchObject({ ok: true, bcc: [] });

    const unavailable = buildReplyAllRecipients(
      input({ bcc: [], bccProvenance: "unavailable" }),
      [],
    );
    expect(unavailable).toMatchObject({
      ok: false,
      code: "reply_all_bcc_confirmation_required",
    });
  });

  it("requires the exact confirmation and a typed Bcc for unavailable provenance", () => {
    const base = input({ bcc: [], bccProvenance: "unavailable" });

    expect(
      buildReplyAllRecipients(base, [], {
        bccConfirmation: "confirmed-missing-bcc",
        typedBcc: [address("manual@example.com")],
      }),
    ).toMatchObject({
      ok: false,
      code: "reply_all_bcc_confirmation_required",
    });

    const result = buildReplyAllRecipients(base, [], {
      bccConfirmation: REPLY_ALL_BCC_CONFIRMATION,
      typedBcc: [address("manual@example.com")],
    });
    expect(result).toEqual({
      ok: true,
      to: [address("sender@example.com", "Sender"), address("owner@movo.com.my"), address("to@example.com")],
      cc: [address("cc@example.com")],
      bcc: [address("manual@example.com")],
    });
  });

  it("fails closed when every candidate is the current user's address", () => {
    const result = buildReplyAllRecipients(
      input({
        from: address("owner@movo.com.my"),
        to: [address("owner@movo.com.my")],
        cc: [],
        bcc: [],
        bccProvenance: "known-empty",
      }),
      ["owner@movo.com.my"],
    );

    expect(result).toMatchObject({ ok: false, code: "reply_all_no_recipients" });
  });

  it("does not silently discard malformed recipient entries", () => {
    const result = buildReplyAllRecipients(
      input({
        to: [address("not-an-email")],
      }),
      [],
    );

    expect(result).toMatchObject({ ok: false, code: "invalid_recipient" });
  });

  it("rejects recipient objects with unknown fields", () => {
    const result = buildReplyAllRecipients(
      input({
        to: [
          {
            address: "valid@example.com",
            unexpected: "must-not-be-forwarded",
          } as EmailAddress,
        ],
      }),
      [],
    );

    expect(result).toMatchObject({ ok: false, code: "invalid_recipient" });
  });
});
