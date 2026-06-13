import { describe, it, expect } from "vitest";
import {
  resolveActiveMailboxId,
  switcherMailboxes,
  ALL_MAILBOXES,
  isUnclaimedShared,
} from "./mailbox";
import type { MailboxSummary } from "./api";
import type { Thread } from "./types";

describe("resolveActiveMailboxId", () => {
  // Owned = personal mailboxes the caller owns; selectable = those plus every
  // shared mailbox the switcher can target. selectable ⊇ owned.
  const owned = ["mb-1", "mb-2", "mb-3"];

  it("returns null when the caller owns no mailboxes", () => {
    expect(resolveActiveMailboxId([], [], "mb-1", "mb-2")).toBeNull();
  });

  it("prefers a valid override over stored and first", () => {
    expect(resolveActiveMailboxId(owned, owned, "mb-2", "mb-3")).toBe("mb-2");
  });

  it("ignores an override that is not selectable and falls back to stored", () => {
    expect(resolveActiveMailboxId(owned, owned, "not-owned", "mb-3")).toBe("mb-3");
  });

  it("uses stored when there is no override", () => {
    expect(resolveActiveMailboxId(owned, owned, null, "mb-2")).toBe("mb-2");
  });

  it("ignores a stored id that is no longer selectable and falls back to first owned", () => {
    expect(resolveActiveMailboxId(owned, owned, null, "gone")).toBe("mb-1");
  });

  it("defaults to the first owned mailbox when neither override nor stored apply", () => {
    expect(resolveActiveMailboxId(owned, owned, null, null)).toBe("mb-1");
  });

  it("honors the ALL sentinel (override or stored) when more than one is selectable", () => {
    expect(resolveActiveMailboxId(owned, owned, ALL_MAILBOXES, null)).toBe(
      ALL_MAILBOXES,
    );
    expect(resolveActiveMailboxId(owned, owned, null, ALL_MAILBOXES)).toBe(
      ALL_MAILBOXES,
    );
  });

  it("ignores the ALL sentinel when only one mailbox is selectable", () => {
    expect(
      resolveActiveMailboxId(["mb-1"], ["mb-1"], ALL_MAILBOXES, ALL_MAILBOXES),
    ).toBe("mb-1");
  });

  it("honors a stored SHARED id that is selectable but not owned (sticky across reload)", () => {
    // One owned personal mailbox + one shared mailbox in scope.
    const ownedOne = ["mb-1"];
    const selectable = ["mb-1", "mb-shared"];
    expect(
      resolveActiveMailboxId(ownedOne, selectable, null, "mb-shared"),
    ).toBe("mb-shared");
  });

  it("treats ALL as eligible when a shared mailbox makes selectable > 1 even with one owned", () => {
    const ownedOne = ["mb-1"];
    const selectable = ["mb-1", "mb-shared"];
    expect(
      resolveActiveMailboxId(ownedOne, selectable, ALL_MAILBOXES, null),
    ).toBe(ALL_MAILBOXES);
  });

  it("still defaults to the first OWNED mailbox, never a shared one", () => {
    const ownedOne = ["mb-1"];
    const selectable = ["mb-shared", "mb-1"]; // shared sorts first alphabetically
    expect(resolveActiveMailboxId(ownedOne, selectable, null, null)).toBe("mb-1");
  });
});

describe("switcherMailboxes", () => {
  const personal: MailboxSummary = {
    id: "mb-1",
    address: "me@movo.com.my",
    displayName: "Me",
    kind: "personal",
  };
  const shared: MailboxSummary = {
    id: "mb-shared",
    address: "service@movo.com.my",
    displayName: "Service",
    kind: "shared",
  };

  it("includes BOTH personal and shared mailboxes as switcher options", () => {
    const result = switcherMailboxes([personal, shared]);
    expect(result.map((m) => m.id)).toEqual(["mb-1", "mb-shared"]);
  });

  it("does not drop shared mailboxes (regression: shared used to be filtered out)", () => {
    expect(switcherMailboxes([shared]).map((m) => m.id)).toEqual(["mb-shared"]);
  });

  it("returns an empty list for no mailboxes", () => {
    expect(switcherMailboxes([])).toEqual([]);
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
