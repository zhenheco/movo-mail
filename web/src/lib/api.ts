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

/**
 * Like `request` but for endpoints whose success carries no JSON body (e.g. a
 * DELETE returning 204 or an empty 200). Shares the exact same error mapping —
 * only the success path differs (no parse).
 */
async function requestNoContent(
  path: string,
  init?: RequestInit,
): Promise<void> {
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
    throw new ApiError(
      "Network error — check your connection and try again.",
      0,
    );
  }

  if (!response.ok) {
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
}

/** A mailbox the caller owns, as returned by GET /api/mailboxes. */
export type MailboxKind = "personal" | "shared";

export interface MailboxSummary {
  id: string;
  address: string;
  displayName: string | null;
  kind: MailboxKind;
}

/**
 * GET /api/mailboxes — the caller's own mailboxes (scoped to the Access
 * identity). The primary source the UI uses to auto-resolve the active inbox.
 */
export async function fetchMailboxes(): Promise<MailboxSummary[]> {
  const data = await request<{ mailboxes: MailboxSummary[] }>(`/mailboxes`);
  return data.mailboxes;
}

/**
 * GET /api/mailboxes/sendable — every mailbox the caller may send from:
 * owned personal mailboxes plus all shared mailboxes.
 */
export async function fetchSendableMailboxes(): Promise<MailboxSummary[]> {
  const data = await request<{ mailboxes: MailboxSummary[] }>(
    `/mailboxes/sendable`,
  );
  return data.mailboxes;
}

/** GET /api/threads?mailbox=<id> */
export async function fetchThreads(mailboxId: string): Promise<Thread[]> {
  const data = await request<{ threads: Thread[] }>(
    `/threads${buildQuery({ mailbox: mailboxId })}`,
  );
  return data.threads;
}

/**
 * GET /api/threads/all — the unified inbox: threads across every mailbox the
 * caller owns (server-scoped to ownership). Each thread keeps its mailbox_id so
 * the UI can label its source mailbox.
 */
export async function fetchAllThreads(): Promise<Thread[]> {
  const data = await request<{ threads: Thread[] }>(`/threads/all`);
  return data.threads;
}

/** GET /api/message/:id (html_body is sanitized client-side before render). */
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
export async function sendMessage(
  body: SendRequest,
  idempotencyKey: string,
): Promise<SendResult> {
  return await request<SendResult>(`/send`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
}

/** POST /api/ai/draft — returns a draft only; the UI never auto-sends. */
export async function aiDraft(body: AiDraftRequest): Promise<AiDraftResult> {
  const data = await request<{ draft: AiDraftResult }>(`/ai/draft`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.draft;
}

// ── Admin: self-service mailbox management ───────────────────────────────────

/** The caller's identity + whether they hold the admin role. */
export interface Me {
  email: string;
  isAdmin: boolean;
}

/**
 * GET /api/me — the signed-in identity plus the admin flag the UI uses to gate
 * the Settings panel. Non-admins simply receive `isAdmin: false`.
 *
 * The server returns a FLAT `{ email, isAdmin }` object (see src/api/me.ts), so
 * we read it directly — wrapping it in a `.me` envelope would resolve to
 * undefined and silently disable the admin UI for real admins.
 */
export async function fetchMe(): Promise<Me> {
  return await request<Me>(`/me`);
}

/** A mailbox row in the admin table (all mailboxes, not scoped to the caller). */
export interface AdminMailbox {
  id: string;
  address: string;
  displayName: string | null;
  ownerEmail: string | null;
  kind: MailboxKind;
}

/** Body for creating a mailbox from the admin panel. */
export interface CreateAdminMailboxBody {
  address: string;
  ownerEmail?: string;
  displayName?: string;
  kind?: MailboxKind;
}

/** GET /api/admin/mailboxes — every managed mailbox (admin only). */
export async function fetchAdminMailboxes(): Promise<AdminMailbox[]> {
  const data = await request<{ mailboxes: AdminMailbox[] }>(`/admin/mailboxes`);
  return data.mailboxes;
}

/**
 * POST /api/admin/mailboxes — create a managed mailbox (a D1 write; the
 * catch-all already routes every address to the worker). The server then sends
 * a best-effort welcome email to the owner's login email and reports whether it
 * went out via `welcomeEmailSent`. Surfaces server 4xx messages (e.g. 409
 * duplicate, 400 bad address) via ApiError.
 */
export async function createAdminMailbox(
  body: CreateAdminMailboxBody,
): Promise<{ id: string; welcomeEmailSent: boolean }> {
  return await request<{ id: string; welcomeEmailSent: boolean }>(
    `/admin/mailboxes`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

/**
 * DELETE /api/admin/mailboxes/:id — remove a managed mailbox (admin only).
 *
 * Uses the raw, non-JSON request helper so a 204/empty 200 succeeds (a delete
 * carries no payload the UI needs); error mapping still goes through ApiError.
 */
export async function deleteAdminMailbox(id: string): Promise<void> {
  await requestNoContent(`/admin/mailboxes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
