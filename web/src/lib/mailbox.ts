import type { MailboxSummary } from "./api";

/**
 * Resolve an OVERRIDE mailbox id.
 *
 * The primary source of the active mailbox is now the API (GET /api/mailboxes,
 * via api.fetchMailboxes), which auto-resolves the caller's own inbox so a user
 * never types an id. This helper provides explicit OVERRIDES only, in priority
 * order:
 *   1. the `?mailbox=` URL query (handy for switching between owned mailboxes /
 *      debugging), then
 *   2. the build-time `VITE_DEFAULT_MAILBOX` env var.
 * Returns null when no override is set, so the caller can fall back to the API.
 */

export function resolveMailboxId(
  search: string,
  env: Record<string, string | undefined>,
): string | null {
  try {
    const params = new URLSearchParams(search);
    const fromQuery = params.get("mailbox");
    if (fromQuery && fromQuery.trim().length > 0) {
      return fromQuery.trim();
    }
  } catch {
    // Malformed search string — fall through to env.
  }
  const fromEnv = env.VITE_DEFAULT_MAILBOX;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return null;
}

/**
 * Resolve a FALLBACK From address for outbound sends.
 *
 * The primary From address is the resolved mailbox's `address` (from the API).
 * This helper is the fallback used only when no resolved address is available:
 * it reads `VITE_DEFAULT_FROM` (an email like `name@movo.com.my`), then falls
 * back to the mailbox id when that already looks like an address.
 */
export function resolveFromAddress(
  env: Record<string, string | undefined>,
  mailboxId: string,
): string {
  const fromEnv = env.VITE_DEFAULT_FROM;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return mailboxId;
}

/**
 * Sentinel "active mailbox" meaning the unified inbox (all owned mailboxes
 * merged). Distinct from any real mailbox id. Only meaningful when the caller
 * owns more than one mailbox.
 */
export const ALL_MAILBOXES = "__all__";

export function isUnclaimedShared(
  thread: { mailbox_id: string; assignee_id: string | null },
  mailboxesById: Record<string, Pick<MailboxSummary, "kind"> | undefined>,
): boolean {
  return (
    mailboxesById[thread.mailbox_id]?.kind === "shared" &&
    thread.assignee_id === null
  );
}

/**
 * Pick the ACTIVE mailbox id from the caller's owned set, for the multi-mailbox
 * switcher. Precedence (only ids actually owned are eligible, since the read API
 * scopes to owned mailboxes anyway; the ALL_MAILBOXES sentinel is eligible only
 * when there is a real choice, i.e. >1 owned):
 *   1. `override` — the ?mailbox= query / VITE_DEFAULT_MAILBOX, if owned (or ALL).
 *   2. `stored`   — the last switcher choice (localStorage), if owned (or ALL).
 *   3. the first owned mailbox.
 * Returns null only when the caller owns no mailboxes.
 */
export function resolveActiveMailboxId(
  ownedIds: string[],
  override: string | null,
  stored: string | null,
): string | null {
  if (ownedIds.length === 0) {
    return null;
  }
  const allEligible = ownedIds.length > 1;
  const accepts = (id: string | null): boolean =>
    id != null && ((id === ALL_MAILBOXES && allEligible) || ownedIds.includes(id));

  if (accepts(override)) {
    return override;
  }
  if (accepts(stored)) {
    return stored;
  }
  return ownedIds[0]!;
}
