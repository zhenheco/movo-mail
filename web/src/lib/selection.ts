/**
 * Pure selection-mapping helpers for the webmail shell.
 *
 * Kept free of React/fetch so the inbox→reader resolution can be unit-tested
 * directly. The reading pane is keyed by a MESSAGE id, but inbox rows are
 * THREADS — and a thread id is a different uuid from any message id. Opening a
 * thread therefore means opening its latest message (`last_message_id`), never
 * the thread's own id.
 */

import type { Thread } from "./types";

/** What a thread selection resolves to: the thread + the message to open. */
export interface ThreadSelection {
  /** The selected thread id (drives the highlighted row). */
  selectedThreadId: string;
  /**
   * The message id the reader should load. Null when the thread has no messages
   * yet — ThreadView shows its empty state for null rather than 404-ing on a
   * thread id mistaken for a message id.
   */
  openMessageId: string | null;
}

/**
 * Resolve an inbox thread row to its selection: highlight the thread, but open
 * its latest message (`last_message_id`), not the thread id.
 */
export function selectionForThread(thread: Thread): ThreadSelection {
  return {
    selectedThreadId: thread.id,
    openMessageId: thread.last_message_id,
  };
}
