/**
 * Thread / message reader. Driven by a message id (the read API exposes
 * GET /api/message/:id). Renders the message header, sanitized body, and any
 * attachment metadata, plus a "Reply" action that opens Compose pre-filled for
 * threading.
 *
 * NOTE: the documented read surface is /threads, /message/:id and /search; there
 * is no per-thread message-list endpoint, so a single message is the unit shown
 * here. Selecting an inbox thread or a search hit resolves to a message id which
 * is loaded via fetchMessage().
 */

import type { MessageWithAttachments } from "../lib/types";
import { fetchMessage } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { displaySender, formatDate, parseAddresses } from "../lib/format";
import { MessageBody } from "./MessageBody";
import { Button } from "./ui/button";
import { EmptyState, ErrorState, LoadingState } from "./ui/feedback";

export interface ThreadViewProps {
  messageId: string | null;
  onReply: (message: MessageWithAttachments) => void;
}

export function ThreadView({ messageId, onReply }: ThreadViewProps) {
  const state = useAsync<MessageWithAttachments>(
    () => fetchMessage(messageId as string),
    [messageId],
    { enabled: messageId !== null },
  );

  if (messageId === null) {
    return (
      <section className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select a conversation to read it here.
      </section>
    );
  }
  if (state.loading) {
    return (
      <section className="flex-1">
        <LoadingState label="Loading message…" />
      </section>
    );
  }
  if (state.error) {
    return (
      <section className="flex-1">
        <ErrorState message={state.error} onRetry={state.reload} />
      </section>
    );
  }
  const message = state.data;
  if (!message) {
    return (
      <section className="flex-1">
        <EmptyState message="Message unavailable." />
      </section>
    );
  }

  const to = parseAddresses(message.to_addresses);
  const cc = parseAddresses(message.cc_addresses);

  return (
    <section className="flex flex-1 flex-col overflow-hidden">
      <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">
            {message.subject?.trim() || "(no subject)"}
          </h1>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {displaySender(message.from_name, message.from_address)}
            </span>{" "}
            &lt;{message.from_address}&gt;
          </p>
          <p className="truncate text-xs text-muted-foreground">
            To: {to.join(", ") || "—"}
            {cc.length > 0 ? ` · Cc: ${cc.join(", ")}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="text-xs text-muted-foreground">
            {formatDate(message.date)}
          </span>
          <Button size="sm" variant="outline" onClick={() => onReply(message)}>
            Reply
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <MessageBody html={message.html_body} text={message.text_body} />

        {message.attachments && message.attachments.length > 0 ? (
          <div className="mt-6 border-t border-border pt-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Attachments
            </p>
            <ul className="flex flex-wrap gap-2">
              {message.attachments.map((att) => (
                <li
                  key={att.id}
                  className="rounded-md border border-border px-3 py-1.5 text-xs"
                  title={`${att.content_type ?? "file"} · ${att.size_bytes} bytes`}
                >
                  <a href={`/api/attachment/${encodeURIComponent(att.id)}`}>
                    {att.filename || "(unnamed)"}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
