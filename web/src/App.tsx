/**
 * Movo Mail — webmail shell.
 *
 * Three regions: Inbox (ThreadList) | Thread reader (ThreadView) | Compose.
 *
 * Active-mailbox resolution (a logged-in user never types an id). On mount we
 * GET /api/mailboxes (every mailbox the caller OWNS — one Gmail can own several
 * @movo.com.my addresses) and pick the active one via resolveActiveMailboxId:
 *   1. ?mailbox= URL query / VITE_DEFAULT_MAILBOX override, if it is owned;
 *   2. the last switcher choice persisted in localStorage, if it is owned;
 *   3. otherwise the first owned mailbox.
 * When the caller owns more than one, a MailboxSwitcher (in ThreadList) lets
 * them change the active mailbox — which drives both the inbox and the Compose
 * From address. Owning zero mailboxes shows a "contact your administrator"
 * empty state; a fetch error surfaces the friendly ApiError message.
 *
 * Selection model: the read API exposes /message/:id (not a per-thread list),
 * so the reader is keyed by a message id. Inbox thread rows and search hits both
 * resolve to a message id which ThreadView loads.
 */

import { useEffect, useMemo, useState } from "react";
import type { Message, MessageWithAttachments, Thread } from "./lib/types";
import {
  ALL_MAILBOXES,
  resolveActiveMailboxId,
  resolveFromAddress,
  resolveMailboxId,
} from "./lib/mailbox";
import {
  ApiError,
  fetchMailboxes,
  fetchMe,
  type MailboxSummary,
} from "./lib/api";
import { selectionForThread } from "./lib/selection";
import { blankDraft, replyDraft, type ComposeDraft } from "./lib/compose";
import { ThreadList } from "./components/ThreadList";
import { ThreadView } from "./components/ThreadView";
import { Compose } from "./components/Compose";
import { AdminPanel } from "./components/AdminPanel";
import { Button } from "./components/ui/button";
import { EmptyState } from "./components/ui/feedback";

/** localStorage key remembering the last active mailbox across reloads. */
const ACTIVE_MAILBOX_KEY = "movo:activeMailbox";

/** Discriminated state machine for mailbox resolution. */
type MailboxState =
  | { status: "loading" }
  | { status: "ready"; boxes: MailboxSummary[]; activeId: string }
  | { status: "empty" }
  | { status: "error"; message: string };

/** Read the stored active-mailbox id (tolerates SSR / disabled storage). */
function readStoredMailboxId(): string | null {
  try {
    return typeof window !== "undefined"
      ? window.localStorage.getItem(ACTIVE_MAILBOX_KEY)
      : null;
  } catch {
    return null;
  }
}

/** Persist the active-mailbox id (best-effort; storage may be unavailable). */
function storeMailboxId(id: string): void {
  try {
    window.localStorage.setItem(ACTIVE_MAILBOX_KEY, id);
  } catch {
    // Storage unavailable (private mode / quota) — selection stays in-memory.
  }
}

export default function App() {
  // Override id from ?mailbox= / VITE_DEFAULT_MAILBOX (honored only if owned).
  const override = useMemo(
    () =>
      resolveMailboxId(
        typeof window !== "undefined" ? window.location.search : "",
        import.meta.env as unknown as Record<string, string | undefined>,
      ),
    [],
  );

  const [mailboxState, setMailboxState] = useState<MailboxState>({
    status: "loading",
  });
  // Bump to re-fetch the owned-mailbox list (e.g. after an admin adds the first
  // mailbox from settings while still in the empty state).
  const [mailboxNonce, setMailboxNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchMailboxes()
      .then((boxes) => {
        if (cancelled) {
          return;
        }
        const activeId = resolveActiveMailboxId(
          boxes.map((b) => b.id),
          override,
          readStoredMailboxId(),
        );
        if (!activeId) {
          setMailboxState({ status: "empty" });
          return;
        }
        setMailboxState({ status: "ready", boxes, activeId });
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
  }, [override, mailboxNonce]);

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

  // Admin settings / mailbox management must be reachable regardless of mailbox
  // state — otherwise an admin who owns zero mailboxes is stranded on the empty
  // state with no way to create the first one. Closing re-fetches the owned list
  // so a freshly-added mailbox shows up immediately.
  if (isAdmin && showSettings) {
    return (
      <AdminPanel
        onClose={() => {
          setShowSettings(false);
          setMailboxNonce((n) => n + 1);
        }}
      />
    );
  }

  if (mailboxState.status === "loading") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <EmptyState message="Loading…" />
      </div>
    );
  }

  if (mailboxState.status === "empty") {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
        <EmptyState
          message={
            isAdmin
              ? "You own no mailboxes yet. Open settings to create one."
              : "No mailbox is provisioned for your account. Contact your administrator."
          }
        />
        {isAdmin ? (
          <Button size="sm" onClick={() => setShowSettings(true)}>
            Manage mailboxes
          </Button>
        ) : null}
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

  const { boxes, activeId } = mailboxState;
  const isAll = activeId === ALL_MAILBOXES;
  const activeBox = boxes.find((b) => b.id === activeId);
  // mailboxId scopes the inbox (the ALL sentinel triggers the unified view in
  // ThreadList). For a NEW message we need a real mailbox to send from, so the
  // unified view defaults composing to the first owned mailbox (Compose still
  // lets the user pick another).
  const mailboxId = activeId;
  const composeMailboxId = isAll ? boxes[0]?.id ?? "" : activeId;
  const fromAddress =
    activeBox?.address ||
    boxes[0]?.address ||
    resolveFromAddress(
      import.meta.env as unknown as Record<string, string | undefined>,
      activeId,
    );

  function handleSelectThread(thread: Thread) {
    // A thread id and a message id are distinct uuids, so the reader (keyed by
    // a message id) must open the thread's LATEST message, not the thread id.
    // selectionForThread maps to last_message_id; a null id (empty thread) lets
    // ThreadView show its empty state instead of 404-ing on a thread id.
    const { selectedThreadId, openMessageId } = selectionForThread(thread);
    setSelectedThreadId(selectedThreadId);
    setOpenMessageId(openMessageId);
  }

  function handleSelectSearchHit(message: Message) {
    setSelectedThreadId(message.thread_id);
    setOpenMessageId(message.id);
  }

  function handleReply(message: MessageWithAttachments) {
    setCompose(replyDraft(message));
  }

  function handleCompose() {
    setCompose(blankDraft(composeMailboxId));
  }

  function handleSent() {
    setCompose(null);
    setInboxNonce((n) => n + 1);
  }

  /** Return to a clean inbox: clear the open conversation + any compose. */
  function handleHome() {
    setSelectedThreadId(null);
    setOpenMessageId(null);
    setCompose(null);
  }

  /** Switch the active mailbox: persist, scope the inbox, reset the open view. */
  function handleSwitchMailbox(id: string) {
    if (mailboxState.status !== "ready" || id === mailboxState.activeId) {
      return;
    }
    storeMailboxId(id);
    setMailboxState({ ...mailboxState, activeId: id });
    handleHome();
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <ThreadList
        // key forces a fresh mount (and refetch) when we want the inbox to reload
        key={`inbox-${mailboxId}-${inboxNonce}`}
        mailboxId={mailboxId}
        selectedThreadId={selectedThreadId}
        onSelectThread={handleSelectThread}
        onSelectSearchHit={handleSelectSearchHit}
        onCompose={handleCompose}
        onHome={handleHome}
        onOpenSettings={isAdmin ? () => setShowSettings(true) : undefined}
        mailboxes={boxes}
        onSwitchMailbox={handleSwitchMailbox}
      />

      <main aria-label="Conversation" className="flex flex-1 flex-col overflow-hidden">
        <ThreadView messageId={openMessageId} onReply={handleReply} />
        {compose ? (
          <Compose
            fromAddress={fromAddress}
            initial={compose}
            fromOptions={boxes}
            onClose={() => setCompose(null)}
            onSent={handleSent}
          />
        ) : null}
      </main>
    </div>
  );
}
