/**
 * Movo Mail — webmail shell.
 *
 * Three regions: Inbox (ThreadList) | Thread reader (ThreadView) | Compose.
 *
 * Active-mailbox resolution precedence (a logged-in user never types an id):
 *   1. Override — ?mailbox= URL query or VITE_DEFAULT_MAILBOX (for switching
 *      between owned mailboxes / debugging). Resolved synchronously.
 *   2. Otherwise — GET /api/mailboxes on mount and pick the FIRST mailbox the
 *      caller owns (its id drives the inbox; its address drives the From header).
 * If the user owns zero mailboxes we show a "contact your administrator" empty
 * state; on a fetch error we surface the friendly ApiError message.
 *
 * Selection model: the read API exposes /message/:id (not a per-thread list),
 * so the reader is keyed by a message id. Inbox thread rows and search hits both
 * resolve to a message id which ThreadView loads.
 */

import { useEffect, useMemo, useState } from "react";
import type { Message, MessageWithAttachments, Thread } from "./lib/types";
import { resolveFromAddress, resolveMailboxId } from "./lib/mailbox";
import { ApiError, fetchMailboxes, fetchMe } from "./lib/api";
import { blankDraft, replyDraft, type ComposeDraft } from "./lib/compose";
import { ThreadList } from "./components/ThreadList";
import { ThreadView } from "./components/ThreadView";
import { Compose } from "./components/Compose";
import { AdminPanel } from "./components/AdminPanel";
import { EmptyState } from "./components/ui/feedback";

/** Resolved active mailbox: its id (for scoping) + From address (for sends). */
interface ResolvedMailbox {
  id: string;
  address: string;
}

/** Discriminated state machine for mailbox resolution. */
type MailboxState =
  | { status: "loading" }
  | { status: "resolved"; mailbox: ResolvedMailbox }
  | { status: "empty" }
  | { status: "error"; message: string };

export default function App() {
  // Synchronous override (query / env). When present we skip the API entirely.
  const override = useMemo(
    () =>
      resolveMailboxId(
        typeof window !== "undefined" ? window.location.search : "",
        import.meta.env as unknown as Record<string, string | undefined>,
      ),
    [],
  );

  const [mailboxState, setMailboxState] = useState<MailboxState>(() =>
    override
      ? {
          status: "resolved",
          mailbox: {
            id: override,
            address: resolveFromAddress(
              import.meta.env as unknown as Record<string, string | undefined>,
              override,
            ),
          },
        }
      : { status: "loading" },
  );

  useEffect(() => {
    // Override already resolved synchronously — no API call needed.
    if (override) {
      return;
    }
    let cancelled = false;
    fetchMailboxes()
      .then((boxes) => {
        if (cancelled) {
          return;
        }
        const first = boxes[0];
        if (!first) {
          setMailboxState({ status: "empty" });
          return;
        }
        setMailboxState({
          status: "resolved",
          mailbox: {
            id: first.id,
            // Prefer the resolved mailbox address; fall back to env/id.
            address:
              first.address ||
              resolveFromAddress(
                import.meta.env as unknown as Record<
                  string,
                  string | undefined
                >,
                first.id,
              ),
          },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        const message =
          err instanceof ApiError
            ? err.message
            : "We could not load your mailboxes. Please reload the page.";
        setMailboxState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [override]);

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [openMessageId, setOpenMessageId] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeDraft | null>(null);
  // Bump to force the inbox to re-fetch after a send.
  const [inboxNonce, setInboxNonce] = useState(0);
  // Admin gating + settings panel visibility (independent of mailbox state).
  const [isAdmin, setIsAdmin] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // A failed identity probe simply leaves the admin UI hidden — never blocks
    // the inbox.
    fetchMe()
      .then((me) => {
        if (!cancelled) {
          setIsAdmin(me.isAdmin);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsAdmin(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (mailboxState.status === "loading") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <EmptyState message="Loading…" />
      </div>
    );
  }

  if (mailboxState.status === "empty") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <EmptyState message="No mailbox is provisioned for your account. Contact your administrator." />
      </div>
    );
  }

  if (mailboxState.status === "error") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <EmptyState message={mailboxState.message} />
      </div>
    );
  }

  const mailboxId = mailboxState.mailbox.id;
  const fromAddress = mailboxState.mailbox.address;

  // Admin settings panel replaces the main pane while open. Guarded by isAdmin
  // so a stale flag (or a non-admin) can never reach it.
  if (isAdmin && showSettings) {
    return <AdminPanel onClose={() => setShowSettings(false)} />;
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
    setCompose(blankDraft(mailboxId));
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
        onOpenSettings={isAdmin ? () => setShowSettings(true) : undefined}
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
