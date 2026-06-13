import { describe, it, expect } from "vitest";
import {
  resolveActiveMailboxId,
  ALL_MAILBOXES,
  isUnclaimedShared,
} from "./mailbox";
import type { MailboxSummary } from "./api";
import type { Thread } from "./types";

describe("resolveActiveMailboxId", () => {
  const owned = ["mb-1", "mb-2", "mb-3"];

  it("returns null when the caller owns no mailboxes", () => {
    expect(resolveActiveMailboxId([], "mb-1", "mb-2")).toBeNull();
  });

  it("prefers a valid override over stored and first", () => {
    expect(resolveActiveMailboxId(owned, "mb-2", "mb-3")).toBe("mb-2");
  });

  it("ignores an override that is not owned and falls back to stored", () => {
    expect(resolveActiveMailboxId(owned, "not-owned", "mb-3")).toBe("mb-3");
  });

  it("uses stored when there is no override", () => {
    expect(resolveActiveMailboxId(owned, null, "mb-2")).toBe("mb-2");
  });

  it("ignores a stored id that is no longer owned and falls back to first", () => {
    expect(resolveActiveMailboxId(owned, null, "gone")).toBe("mb-1");
  });

  it("defaults to the first owned mailbox when neither override nor stored apply", () => {
    expect(resolveActiveMailboxId(owned, null, null)).toBe("mb-1");
  });

  it("honors the ALL sentinel (override or stored) when more than one is owned", () => {
    expect(resolveActiveMailboxId(owned, ALL_MAILBOXES, null)).toBe(ALL_MAILBOXES);
    expect(resolveActiveMailboxId(owned, null, ALL_MAILBOXES)).toBe(ALL_MAILBOXES);
  });

  it("ignores the ALL sentinel when only one mailbox is owned", () => {
    expect(resolveActiveMailboxId(["mb-1"], ALL_MAILBOXES, ALL_MAILBOXES)).toBe(
      "mb-1",
    );
  });
});

describe("isUnclaimedShared", () => {
  const mailboxesById: Record<string, MailboxSummary> = {
    "mb-personal": {
      id: "mb-personal",
      address: "me@movo.com.my",
      displayName: "Me",
      kind: "personal",
    },
    "mb-shared": {
      id: "mb-shared",
      address: "service@movo.com.my",
      displayName: "Service",
      kind: "shared",
    },
  };

  function thread(
    mailboxId: string,
    assigneeId: string | null,
  ): Pick<Thread, "mailbox_id" | "assignee_id"> {
    return { mailbox_id: mailboxId, assignee_id: assigneeId };
  }

  it("is true for an unassigned thread in a shared mailbox", () => {
    expect(isUnclaimedShared(thread("mb-shared", null), mailboxesById)).toBe(
      true,
    );
  });

  it("is false once a shared thread is assigned", () => {
    expect(isUnclaimedShared(thread("mb-shared", "user-1"), mailboxesById)).toBe(
      false,
    );
  });

  it("is false for unassigned personal or unknown mailboxes", () => {
    expect(isUnclaimedShared(thread("mb-personal", null), mailboxesById)).toBe(
      false,
    );
    expect(isUnclaimedShared(thread("mb-missing", null), mailboxesById)).toBe(
      false,
    );
  });
});
