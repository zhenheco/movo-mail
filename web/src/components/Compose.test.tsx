import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Compose } from "./Compose";
import type { MailboxSummary } from "../lib/api";
import type { ComposeDraft } from "../lib/compose";

const baseDraft: ComposeDraft = {
  to: "",
  subject: "",
  body: "",
  mailboxId: "mb-personal",
};

function renderCompose(fromOptions: MailboxSummary[]): string {
  return renderToStaticMarkup(
    <Compose
      fromAddress="me@movo.com.my"
      initial={baseDraft}
      fromOptions={fromOptions}
      onClose={() => undefined}
      onSent={() => undefined}
    />,
  );
}

describe("Compose", () => {
  it("marks shared From options without marking personal options", () => {
    const html = renderCompose([
      {
        id: "mb-personal",
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
    ]);

    expect(html).toContain("Me &lt;me@movo.com.my&gt;");
    expect(html).not.toContain("Me &lt;me@movo.com.my&gt;（共用）");
    expect(html).toContain("Service &lt;service@movo.com.my&gt;（共用）");
  });

  it("does not show shared copy when every From option is personal", () => {
    const html = renderCompose([
      {
        id: "mb-personal",
        address: "me@movo.com.my",
        displayName: "Me",
        kind: "personal",
      },
      {
        id: "mb-sales",
        address: "sales@movo.com.my",
        displayName: "Sales",
        kind: "personal",
      },
    ]);

    expect(html).not.toContain("（共用）");
  });
});
