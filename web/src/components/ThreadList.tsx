/**
 * Inbox: the list of threads for the active mailbox. Shows unread state, a
 * search box that switches between thread listing and search results, and full
 * loading / error / empty handling.
 */

import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Message, Thread } from "../lib/types";
import {
  fetchThreads,
  fetchAllThreads,
  searchMessages,
  type MailboxSummary,
} from "../lib/api";
import { ALL_MAILBOXES, isUnclaimedShared, switcherMailboxes } from "../lib/mailbox";
import { useAsync } from "../lib/useAsync";
import { formatDate } from "../lib/format";
import { cn } from "../lib/cn";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { MailboxSwitcher } from "./MailboxSwitcher";
import { EmptyState, ErrorState, LoadingState } from "./ui/feedback";
import { Badge } from "./ui/badge";

export interface ThreadListProps {
  mailboxId: string;
  selectedThreadId: string | null;
  onSelectThread: (thread: Thread) => void;
  /** Selecting a search hit jumps straight to that message's thread. */
  onSelectSearchHit: (message: Message) => void;
  onCompose: () => void;
  /** Click the "Movo Mail" wordmark to return to a clean inbox. */
  onHome: () => void;
  /** Admin-only: open the mailbox settings panel. Omitted for non-admins. */
  onOpenSettings?: () => void;
  /** All owned mailboxes — drives the switcher (rendered only when >1). */
  mailboxes?: MailboxSummary[];
  /** Switch the active mailbox. */
  onSwitchMailbox?: (id: string) => void;
}

export function ThreadList({
  mailboxId,
  selectedThreadId,
  onSelectThread,
  onSelectSearchHit,
  onCompose,
  onHome,
  onOpenSettings,
  mailboxes,
  onSwitchMailbox,
}: ThreadListProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [activeQuery, setActiveQuery] = useState("");

  // Unified inbox: merge threads across every owned mailbox, and label each row
  // with its source mailbox. Search broadens to all owned mailboxes too.
  const isAll = mailboxId === ALL_MAILBOXES;

  const mailboxById = useMemo(
    () =>
      Object.fromEntries((mailboxes ?? []).map((m) => [m.id, m])) as Record<
        string,
        MailboxSummary
      >,
    [mailboxes],
  );

  // The switcher targets the caller's own personal mailboxes AND every shared
  // mailbox in scope, plus the unified "All" view. Picking a shared mailbox
  // scopes the inbox to it (the backend's visible-thread predicate decides
  // which threads show: admins see all, others see unclaimed + their own).
  const switchableMailboxes = useMemo(
    () => switcherMailboxes(mailboxes ?? []),
    [mailboxes],
  );

  const threadsState = useAsync<Thread[]>(
    () => (isAll ? fetchAllThreads() : fetchThreads(mailboxId)),
    [mailboxId],
    { enabled: activeQuery.trim() === "" },
  );

  const searchState = useAsync<Message[]>(
    () => searchMessages(activeQuery, isAll ? undefined : mailboxId),
    [mailboxId, activeQuery],
    { enabled: activeQuery.trim() !== "" },
  );

  const isSearching = activeQuery.trim() !== "";

  function submitSearch(e: FormEvent) {
    e.preventDefault();
    setActiveQuery(searchTerm);
  }

  function clearSearch() {
    setSearchTerm("");
    setActiveQuery("");
  }

  return (
    <aside
      aria-label="Inbox"
      className="flex w-80 shrink-0 flex-col border-r border-border"
    >
      <header className="flex h-14 items-center justify-between gap-2 px-4">
        <button
          type="button"
          onClick={onHome}
          className="cursor-pointer rounded font-semibold transition-colors hover:text-primary"
          aria-label="Movo Mail — back to inbox"
          title="Back to inbox"
        >
          <img src="/movo-logo.svg" alt="Movo Mail" className="h-7 w-auto" />
        </button>
        {onOpenSettings ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenSettings}
            aria-label="Mailbox settings"
            title="Mailbox settings"
          >
            <GearIcon />
          </Button>
        ) : null}
      </header>

      {/* Mailbox switcher — rendered when there's a real choice (more than one
          selectable mailbox across owned personal + shared). Each personal and
          shared mailbox is an option, plus the unified "All" view. */}
      {onSwitchMailbox && switchableMailboxes.length > 1 ? (
        <MailboxSwitcher
          mailboxes={switchableMailboxes}
          activeId={mailboxId}
          onSwitch={onSwitchMailbox}
        />
      ) : null}

      {/* Gmail-style raised "Compose" pill above the inbox. */}
      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={onCompose}
          aria-label="Compose new email"
          className="inline-flex cursor-pointer items-center gap-3 rounded-2xl bg-muted px-5 py-3.5 text-sm font-medium text-foreground shadow-md ring-1 ring-border/60 transition-shadow hover:shadow-lg"
        >
          <PencilIcon />
          撰寫
        </button>
      </div>

      <form
        onSubmit={submitSearch}
        className="flex items-center gap-2 px-3 pb-3"
        role="search"
      >
        <Input
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search mail…"
          aria-label="Search mail"
        />
        {isSearching ? (
          <Button variant="ghost" size="sm" onClick={clearSearch}>
            Clear
          </Button>
        ) : null}
      </form>

      <div className="flex-1 overflow-y-auto">
        {isSearching ? (
          <SearchResults
            state={searchState}
            onSelectSearchHit={onSelectSearchHit}
          />
        ) : (
          <ThreadRows
            state={threadsState}
            selectedThreadId={selectedThreadId}
            onSelectThread={onSelectThread}
            showSource={isAll}
            mailboxById={mailboxById}
          />
        )}
      </div>
    </aside>
  );
}

function ThreadRows({
  state,
  selectedThreadId,
  onSelectThread,
  showSource,
  mailboxById,
}: {
  state: ReturnType<typeof useAsync<Thread[]>>;
  selectedThreadId: string | null;
  onSelectThread: (thread: Thread) => void;
  /** Unified inbox: show each thread's source-mailbox chip. */
  showSource: boolean;
  mailboxById: Record<string, MailboxSummary>;
}) {
  if (state.loading) {
    return <LoadingState label="Loading inbox…" />;
  }
  if (state.error) {
    return <ErrorState message={state.error} onRetry={state.reload} />;
  }
  const threads = state.data ?? [];
  if (threads.length === 0) {
    return <EmptyState message="No conversations yet." />;
  }
  return (
    <ul className="divide-y divide-border">
      {threads.map((thread) => (
        <li key={thread.id}>
          <ThreadRow
            thread={thread}
            selected={thread.id === selectedThreadId}
            onSelect={() => onSelectThread(thread)}
            sourceAddress={
              showSource
                ? mailboxById[thread.mailbox_id]?.address ?? null
                : null
            }
            isUnclaimed={isUnclaimedShared(thread, mailboxById)}
          />
        </li>
      ))}
    </ul>
  );
}

function ThreadRow({
  thread,
  selected,
  onSelect,
  sourceAddress,
  isUnclaimed,
}: {
  thread: Thread;
  selected: boolean;
  onSelect: () => void;
  /** Source-mailbox address chip (unified inbox); null hides it. */
  sourceAddress: string | null;
  isUnclaimed: boolean;
}) {
  const unread = thread.unread === 1;
  return (
    <button
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-muted",
        selected && "bg-muted",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "truncate text-sm",
            unread ? "font-semibold" : "font-normal",
          )}
        >
          {thread.subject?.trim() || "(no subject)"}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatDate(thread.last_message_at)}
        </span>
      </div>
      {sourceAddress ? (
        <span className="w-fit max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {sourceAddress}
        </span>
      ) : null}
      <div className="flex items-center gap-2">
        {isUnclaimed ? <Badge variant="unclaimed">未認領</Badge> : null}
        {unread ? (
          <span
            aria-label="Unread"
            className="h-2 w-2 shrink-0 rounded-full bg-primary"
          />
        ) : null}
        <span className="truncate text-xs text-muted-foreground">
          {thread.snippet?.trim() || "No preview available."}
        </span>
      </div>
    </button>
  );
}

/** Inline pencil glyph for the Compose pill (no icon dep). */
function PencilIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 text-muted-foreground"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/** Inline gear glyph for the admin Settings button (no icon dep). */
function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function SearchResults({
  state,
  onSelectSearchHit,
}: {
  state: ReturnType<typeof useAsync<Message[]>>;
  onSelectSearchHit: (message: Message) => void;
}) {
  const heading = useMemo(
    () => (
      <p className="px-4 py-2 text-xs uppercase tracking-wide text-muted-foreground">
        Search results
      </p>
    ),
    [],
  );

  if (state.loading) {
    return <LoadingState label="Searching…" />;
  }
  if (state.error) {
    return <ErrorState message={state.error} onRetry={state.reload} />;
  }
  const results = state.data ?? [];
  if (results.length === 0) {
    return <EmptyState message="No matching messages." />;
  }
  return (
    <div>
      {heading}
      <ul className="divide-y divide-border">
        {results.map((m) => (
          <li key={m.id}>
            <button
              onClick={() => onSelectSearchHit(m)}
              className="flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-muted"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">
                  {m.subject?.trim() || "(no subject)"}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDate(m.date)}
                </span>
              </div>
              <span className="truncate text-xs text-muted-foreground">
                {m.from_name?.trim() || m.from_address}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
