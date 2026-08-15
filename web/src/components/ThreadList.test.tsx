import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadList, type ThreadListProps } from "./ThreadList";
import { useAsync } from "../lib/useAsync";
import type { SentItem } from "../lib/types";

vi.mock("../lib/useAsync", () => ({
  useAsync: vi.fn(),
}));

const mUseAsync = vi.mocked(useAsync);

const sentItems: SentItem[] = [
  {
    kind: "sent",
    id: "message-1",
    mailboxId: "mb-1",
    subject: "Hello recipient",
    toAddresses: ["recipient@example.com"],
    snippet: "The message body",
    date: 1_700_000_000_000,
    status: "sent",
    error: null,
  },
  {
    kind: "failed",
    id: "log-1",
    mailboxId: "mb-1",
    subject: "Could not deliver",
    toAddresses: ["blocked@example.com"],
    snippet: null,
    date: 1_700_000_000_100,
    status: "failed",
    error: "relay unavailable",
  },
];

const baseProps: ThreadListProps = {
  mailboxId: "mb-1",
  selectedThreadId: null,
  onSelectThread: () => undefined,
  onSelectSearchHit: () => undefined,
  onSelectSentItem: () => undefined,
  onCompose: () => undefined,
  onHome: () => undefined,
  activeView: "sent" as const,
  onViewChange: () => undefined,
  selectedSentItemId: null,
  mailboxes: [],
  onSwitchMailbox: () => undefined,
};

beforeEach(() => {
  mUseAsync.mockImplementation((_, __, options) => ({
    data: options?.enabled === false ? null : sentItems,
    loading: false,
    error: null,
    reload: () => undefined,
  }));
});

describe("ThreadList sent-mail view", () => {
  it("renders accessible inbox/sent tabs and a clickable sent row", () => {
    const html = renderToStaticMarkup(
      <ThreadList {...baseProps} />,
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>寄件備份/);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*>收件匣/);
    expect(html).toContain("Hello recipient");
    expect(html).toContain("recipient@example.com");
    expect(html).toContain("<button");
  });

  it("renders failed rows with error details without making them buttons", () => {
    const html = renderToStaticMarkup(
      <ThreadList {...baseProps} />,
    );

    expect(html).toContain("寄件失敗");
    expect(html).toContain("blocked@example.com");
    expect(html).toContain("Could not deliver");
    expect(html).toContain("relay unavailable");
    expect(html).not.toMatch(/<button[^>]*>[^<]*寄件失敗/);
  });

  it("keeps the controlled sent tab when the mailbox changes", () => {
    const html = renderToStaticMarkup(
      <ThreadList
        {...baseProps}
        mailboxId="mb-2"
      />,
    );

    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>寄件備份/);
  });
});
