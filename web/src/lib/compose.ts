/**
 * Pure helpers for the Compose panel: building a reply draft from a message and
 * assembling the SendRequest payload. No React, no fetch — unit-testable.
 */

import type {
  Direction,
  EmailAddress,
  EpochMs,
  MessageWithAttachments,
  SendRequest,
} from "./types";
import { replySubject } from "./format";

/** History item shape expected by POST /api/ai/draft. */
export interface DraftHistoryItem {
  direction: Direction;
  from: string;
  subject: string | null;
  text: string;
  date: EpochMs;
}

/** Editable state of the compose panel + threading metadata. */
export interface ComposeDraft {
  to: string;
  subject: string;
  body: string;
  /** Set when replying — drives threading + AI draft availability. */
  threadId?: string;
  mailboxId?: string;
  inReplyTo?: string;
  references?: string;
  /** Conversation history for the AI draft request. */
  history?: DraftHistoryItem[];
}

/** A blank new-message draft. */
export function blankDraft(mailboxId: string): ComposeDraft {
  return { to: "", subject: "", body: "", mailboxId };
}

/**
 * Build a reply draft from a message: pre-fills To (original sender), a "Re:"
 * subject, threading headers, and one history item for the AI draft endpoint.
 */
export function replyDraft(message: MessageWithAttachments): ComposeDraft {
  // References chain: existing refs + the message's own Message-ID.
  const refs = [message.references, message.message_id]
    .map((v) => v?.trim())
    .filter((v): v is string => Boolean(v))
    .join(" ");

  const history: DraftHistoryItem[] = [
    {
      direction: message.direction,
      from: message.from_address,
      subject: message.subject,
      text: message.text_body ?? "",
      date: message.date,
    },
  ];

  return {
    to: message.from_address,
    subject: replySubject(message.subject),
    body: "",
    threadId: message.thread_id,
    mailboxId: message.mailbox_id,
    inReplyTo: message.message_id ?? undefined,
    references: refs.length > 0 ? refs : undefined,
    history,
  };
}

export interface BuildSendArgs {
  fromAddress: string;
  to: EmailAddress[];
  subject: string;
  text: string;
  threadId?: string;
  mailboxId?: string;
  inReplyTo?: string;
  references?: string;
}

/**
 * Assemble the POST /api/send body. Threading headers are only attached when
 * present (the cf-email relay may or may not honor them — see spec §11).
 */
export function buildSendRequest(args: BuildSendArgs): SendRequest {
  const headers: Record<string, string> = {};
  if (args.inReplyTo) {
    headers["In-Reply-To"] = args.inReplyTo;
  }
  if (args.references) {
    headers["References"] = args.references;
  }

  const request: SendRequest = {
    from: { address: args.fromAddress },
    to: args.to,
    subject: args.subject.trim(),
    text: args.text,
  };
  if (Object.keys(headers).length > 0) {
    request.headers = headers;
  }
  if (args.threadId) {
    request.threadId = args.threadId;
  }
  if (args.mailboxId) {
    request.mailboxId = args.mailboxId;
  }
  return request;
}
