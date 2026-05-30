/**
 * Movo Mail — webmail shell.
 *
 * Three regions: Inbox (ThreadList) | Thread reader (ThreadView) | Compose.
 * The active mailbox is resolved from ?mailbox= or VITE_DEFAULT_MAILBOX.
 *
 * Selection model: the read API exposes /message/:id (not a per-thread list),
 * so the reader is keyed by a message id. Inbox thread rows and search hits both
 * resolve to a message id which ThreadView loads.
 */

import { useMemo, useState } from "react";
import type { Message, MessageWithAttachments, Thread } from "./lib/types";
import { resolveFromAddress, resolveMailboxId } from "./lib/mailbox";
import { blankDraft, replyDraft, type ComposeDraft } from "./lib/compose";
import { ThreadList } from "./components/ThreadList";
import { ThreadView } from "./components/ThreadView";
import { Compose } from "./components/Compose";
import { EmptyState } from "./components/ui/feedback";

export default function App() {
  const mailboxId = useMemo(
    () =>
      resolveMailboxId(
        typeof window !== "undefined" ? window.location.search : "",
        import.meta.env as unknown as Record<string, string | undefined>,
      ),
    [],
  );

  const fromAddress = useMemo(
    () =>
      mailboxId
        ? resolveFromAddress(
            import.meta.env as unknown as Record<string, string | undefined>,
            mailboxId,
          )
        : "",
    [mailboxId],
  );

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [openMessageId, setOpenMessageId] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeDraft | null>(null);
  // Bump to force the inbox to re-fetch after a send.
  const [inboxNonce, setInboxNonce] = useState(0);

  if (!mailboxId) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <EmptyState message="No mailbox is configured. Set VITE_DEFAULT_MAILBOX or append ?mailbox=<id> to the URL." />
      </div>
    );
  }

  function handleSelectThread(thread: Thread) {
    setSelectedThreadId(thread.id);
    // The read surface keys messages by id; a thread row resolves to its id as
    // the representative message to load (ThreadView handles a 404 gracefully).
    setOpenMessageId(thread.id);
  }

  function handleSelectSearchHit(message: Message) {
    setSelectedThreadId(message.thread_id);
    setOpenMessageId(message.id);
  }

  function handleReply(message: MessageWithAttachments) {
    setCompose(replyDraft(message));
  }

  function handleCompose() {
    setCompose(blankDraft(mailboxId as string));
  }

  function handleSent() {
    setCompose(null);
    setInboxNonce((n) => n + 1);
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <ThreadList
        // key forces a fresh mount (and refetch) when we want the inbox to reload
        key={`inbox-${inboxNonce}`}
        mailboxId={mailboxId}
        selectedThreadId={selectedThreadId}
        onSelectThread={handleSelectThread}
        onSelectSearchHit={handleSelectSearchHit}
        onCompose={handleCompose}
      />

      <main aria-label="Conversation" className="flex flex-1 flex-col overflow-hidden">
        <ThreadView messageId={openMessageId} onReply={handleReply} />
        {compose ? (
          <Compose
            fromAddress={fromAddress}
            initial={compose}
            onClose={() => setCompose(null)}
            onSent={handleSent}
          />
        ) : null}
      </main>
    </div>
  );
}
