import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Compose } from "./Compose";
import type { MailboxSummary } from "../lib/api";
import {
  MAX_ATTACHMENT_COUNT,
  UNAVAILABLE_BCC_CONFIRMATION,
  replyAllDraft,
  type ComposeDraft,
} from "../lib/compose";
import type { MessageWithAttachments } from "../lib/types";

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
  it("renders accessible Traditional Chinese To/Cc/Bcc controls", () => {
    const html = renderToStaticMarkup(
      <Compose
        fromAddress="me@movo.com.my"
        initial={baseDraft}
        fromOptions={[]}
        onClose={() => undefined}
        onSent={() => undefined}
      />,
    );

    expect(html).toContain("收件者");
    expect(html).toContain("副本");
    expect(html).toContain("密件副本");
    expect(html).toContain('id="compose-cc"');
    expect(html).toContain('id="compose-bcc"');
  });

  it("shows the exact unavailable-Bcc confirmation before Reply All can send", () => {
    const message: MessageWithAttachments = {
      id: "message-1",
      thread_id: "thread-1",
      mailbox_id: "mailbox-1",
      message_id: "<message-1@example.com>",
      in_reply_to: null,
      references: null,
      direction: "inbound",
      from_address: "sender@example.com",
      from_name: null,
      to_addresses: JSON.stringify(["me@movo.com.my"]),
      cc_addresses: null,
      bcc_addresses: null,
      subject: "Hello",
      snippet: null,
      text_body: "Hi",
      html_body: null,
      r2_raw_key: null,
      has_attachments: 0,
      unread: 0,
      date: 1,
      created_at: 1,
      attachments: [],
    };
    const html = renderToStaticMarkup(
      <Compose
        fromAddress="me@movo.com.my"
        initial={{
          ...replyAllDraft(message, ["me@movo.com.my"]),
          bcc: "manual-hidden@example.com",
          body: "Confirmed reply body",
        }}
        fromOptions={[]}
        onClose={() => undefined}
        onSent={() => undefined}
      />,
    );

    expect(html).toContain("原始密件副本無法驗證");
    expect(html).toContain(UNAVAILABLE_BCC_CONFIRMATION);
    expect(html).toContain('aria-label="確認原始密件副本無法驗證"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  it("renders the attachment count and picker boundary", () => {
    const html = renderToStaticMarkup(
      <Compose
        fromAddress="me@movo.com.my"
        initial={baseDraft}
        fromOptions={[]}
        onClose={() => undefined}
        onSent={() => undefined}
      />,
    );

    expect(html).toContain(`新增附件（0/${MAX_ATTACHMENT_COUNT}）`);
    expect(html).toContain(`aria-label="新增附件，最多 ${MAX_ATTACHMENT_COUNT} 個"`);
    expect(html).toContain('type="file"');
    expect(html).toContain("multiple");
  });

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
