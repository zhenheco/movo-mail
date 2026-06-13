/**
 * Tests for the pure inbox→reader selection mapping. Regression guard for the
 * bug where clicking a thread opened the THREAD id as if it were a message id,
 * making GET /message/:id 404 ("message not found").
 */

import { describe, it, expect } from "vitest";
import { selectionForThread } from "./selection";
import type { Thread } from "./types";

function makeThread(over: Partial<Thread> = {}): Thread {
  return {
    id: "thread-uuid",
    mailbox_id: "mb-1",
    subject: "Hello",
    snippet: "s",
    last_message_at: 100,
    last_message_id: "message-uuid",
    message_count: 1,
    assignee_id: null,
    unread: 0,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe("selectionForThread", () => {
  it("opens the thread's latest message id, not the thread id", () => {
    const sel = selectionForThread(makeThread());
    expect(sel.selectedThreadId).toBe("thread-uuid");
    expect(sel.openMessageId).toBe("message-uuid");
    // The bug was opening the thread id as a message id.
    expect(sel.openMessageId).not.toBe("thread-uuid");
  });

  it("opens null (empty reader) when the thread has no messages", () => {
    const sel = selectionForThread(makeThread({ last_message_id: null }));
    expect(sel.selectedThreadId).toBe("thread-uuid");
    expect(sel.openMessageId).toBeNull();
  });
});
