/**
 * Typed fetch client for the Movo Mail API.
 *
 * Every call is wrapped so the UI receives either a typed payload or a thrown
 * `ApiError` with a friendly message — no raw network errors leak to render
 * code. All requests are same-origin (the SPA is served by the same Worker
 * behind Cloudflare Access), so the Access JWT cookie rides along automatically.
 */

import type {
  AiDraftRequest,
  AiDraftResult,
  Message,
  MessageWithAttachments,
  SendRequest,
  SendResult,
  Thread,
} from "./types";

/** An API failure with a human-readable, render-safe message. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Map an HTTP status to a friendly, user-facing message. */
export function friendlyStatusMessage(status: number): string {
  if (status === 401 || status === 403) {
    return "You are not signed in or lack access. Try reloading the page.";
  }
  if (status === 404) {
    return "We could not find what you were looking for.";
  }
  if (status === 429) {
    return "Too many requests right now. Please wait a moment and try again.";
  }
  if (status >= 500) {
    return "The server ran into a problem. Please try again shortly.";
  }
  return "Something went wrong. Please try again.";
}

/**
 * Build the query string for a record of optional params, skipping
 * null/undefined/empty values. Pure + exported for unit testing.
 */
export function buildQuery(
  params: Record<string, string | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      search.set(key, value);
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/** Shared fetch wrapper: parses JSON, normalizes errors to ApiError. */
async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    // Network-level failure (offline, DNS, CORS, etc.).
    throw new ApiError(
      "Network error — check your connection and try again.",
      0,
    );
  }

  if (!response.ok) {
    // Surface a server-provided error string only for 4xx, where the server
    // intends it to be user-facing. For 5xx the body may carry internal detail
    // (stack fragments, raw DB messages), so we show only the generic message —
    // App.tsx renders this verbatim, so it must never leak server internals.
    let serverMessage: string | null = null;
    if (response.status < 500) {
      try {
        const data = (await response.json()) as { error?: unknown };
        if (typeof data.error === "string") {
          serverMessage = data.error;
        }
      } catch {
        serverMessage = null;
      }
    }
    throw new ApiError(
      serverMessage
        ? `${friendlyStatusMessage(response.status)} (${serverMessage})`
        : friendlyStatusMessage(response.status),
      response.status,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError("The server returned an unreadable response.", response.status);
  }
}

/** A mailbox the caller owns, as returned by GET /api/mailboxes. */
export interface MailboxSummary {
  id: string;
  address: string;
  displayName: string | null;
}

/**
 * GET /api/mailboxes — the caller's own mailboxes (scoped to the Access
 * identity). The primary source the UI uses to auto-resolve the active inbox.
 */
export async function fetchMailboxes(): Promise<MailboxSummary[]> {
  const data = await request<{ mailboxes: MailboxSummary[] }>(`/mailboxes`);
  return data.mailboxes;
}

/** GET /api/threads?mailbox=<id> */
export async function fetchThreads(mailboxId: string): Promise<Thread[]> {
  const data = await request<{ threads: Thread[] }>(
    `/threads${buildQuery({ mailbox: mailboxId })}`,
  );
  return data.threads;
}

/** GET /api/message/:id (html_body is sanitized server-side). */
export async function fetchMessage(
  id: string,
): Promise<MessageWithAttachments> {
  const data = await request<{ message: MessageWithAttachments }>(
    `/message/${encodeURIComponent(id)}`,
  );
  return data.message;
}

/** GET /api/search?q=&mailbox= */
export async function searchMessages(
  q: string,
  mailboxId?: string,
): Promise<Message[]> {
  const data = await request<{ results: Message[] }>(
    `/search${buildQuery({ q, mailbox: mailboxId })}`,
  );
  return data.results;
}

/** POST /api/send */
export async function sendMessage(body: SendRequest): Promise<SendResult> {
  const data = await request<{ result: SendResult }>(`/send`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.result;
}

/** POST /api/ai/draft — returns a draft only; the UI never auto-sends. */
export async function aiDraft(body: AiDraftRequest): Promise<AiDraftResult> {
  const data = await request<{ draft: AiDraftResult }>(`/ai/draft`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.draft;
}
