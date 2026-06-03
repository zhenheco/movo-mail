import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MailboxSwitcher } from "./MailboxSwitcher";
import type { MailboxSummary } from "../lib/api";

const boxes: MailboxSummary[] = [
  { id: "mb-1", address: "sales@movo.com.my", displayName: "Sales" },
  { id: "mb-2", address: "priss@movo.com.my", displayName: null },
];

describe("MailboxSwitcher", () => {
  it("renders one option per owned mailbox with the active one selected", () => {
    const html = renderToStaticMarkup(
      <MailboxSwitcher mailboxes={boxes} activeId="mb-2" onSwitch={() => undefined} />,
    );
    // Both addresses present as options.
    expect(html).toContain("sales@movo.com.my");
    expect(html).toContain("priss@movo.com.my");
    // Display name is shown when present, in "Name <addr>" form.
    expect(html).toContain("Sales &lt;sales@movo.com.my&gt;");
    // The active mailbox is the selected option.
    expect(html).toMatch(/<option[^>]*value="mb-2"[^>]*selected/);
  });

  it("offers a unified 'All mailboxes' option", () => {
    const html = renderToStaticMarkup(
      <MailboxSwitcher mailboxes={boxes} activeId="__all__" onSwitch={() => undefined} />,
    );
    expect(html).toContain("All mailboxes");
    expect(html).toMatch(/<option[^>]*value="__all__"[^>]*selected/);
  });
});
