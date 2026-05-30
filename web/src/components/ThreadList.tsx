/**
 * Inbox: the list of threads for the active mailbox. Shows unread state, a
 * search box that switches between thread listing and search results, and full
 * loading / error / empty handling.
 */

import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Message, Thread } from "../lib/types";
import { fetchThreads, searchMessages } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { formatDate } from "../lib/format";
import { cn } from "../lib/cn";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { EmptyState, ErrorState, LoadingState } from "./ui/feedback";

export interface ThreadListProps {
  mailboxId: string;
  selectedThreadId: string | null;
  onSelectThread: (thread: Thread) => void;
  /** Selecting a search hit jumps straight to that message's thread. */
  onSelectSearchHit: (message: Message) => void;
  onCompose: () => void;
}

export function ThreadList({
  mailboxId,
  selectedThreadId,
  onSelectThread,
  onSelectSearchHit,
  onCompose,
}: ThreadListProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [activeQuery, setActiveQuery] = useState("");

  const threadsState = useAsync<Thread[]>(
    () => fetchThreads(mailboxId),
    [mailboxId],
    { enabled: activeQuery.trim() === "" },
  );

  const searchState = useAsync<Message[]>(
    () => searchMessages(activeQuery, mailboxId),
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
        <span className="font-semibold">Movo Mail</span>
        <Button size="sm" onClick={onCompose} aria-label="Compose new email">
          Compose
        </Button>
      </header>

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
}: {
  state: ReturnType<typeof useAsync<Thread[]>>;
  selectedThreadId: string | null;
  onSelectThread: (thread: Thread) => void;
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
}: {
  thread: Thread;
  selected: boolean;
  onSelect: () => void;
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
      <div className="flex items-center gap-2">
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
