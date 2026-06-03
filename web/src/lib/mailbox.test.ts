import { describe, it, expect } from "vitest";
import { resolveActiveMailboxId } from "./mailbox";

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
});
