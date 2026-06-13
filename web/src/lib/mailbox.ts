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
 * Mailboxes shown as individual options in the switcher: the caller's own
 * personal mailboxes PLUS every shared mailbox in scope (shared mailboxes are
 * readable by any authenticated user — the backend scopes which THREADS show
 * via the visible-thread predicate). Shared mailboxes used to be filtered out
 * here, leaving them reachable only through the unified "All" view.
 */
export function switcherMailboxes(
  mailboxes: MailboxSummary[],
): MailboxSummary[] {
  return mailboxes.filter(
    (m) => m.kind === "personal" || m.kind === "shared",
  );
}

/**
 * Pick the ACTIVE mailbox id for the multi-mailbox switcher.
 *
 * `ownedIds` are the personal mailboxes the caller owns; `selectableIds` is the
 * superset the switcher can target (owned personal + every shared mailbox).
 * Precedence:
 *   1. `override` — the ?mailbox= query / VITE_DEFAULT_MAILBOX, if selectable (or ALL).
 *   2. `stored`   — the last switcher choice (localStorage), if selectable (or ALL).
 *   3. the first OWNED mailbox (default landing is always a personal inbox,
 *      never a shared one).
 * The ALL_MAILBOXES sentinel is eligible only when there is a real choice, i.e.
 * more than one selectable mailbox (a single owned personal + a shared one
 * counts). Returns null only when the caller owns no mailboxes.
 */
export function resolveActiveMailboxId(
  ownedIds: string[],
  selectableIds: string[],
  override: string | null,
  stored: string | null,
): string | null {
  if (ownedIds.length === 0) {
    return null;
  }
  const allEligible = selectableIds.length > 1;
  const accepts = (id: string | null): boolean =>
    id != null &&
    ((id === ALL_MAILBOXES && allEligible) || selectableIds.includes(id));

  if (accepts(override)) {
    return override;
  }
  if (accepts(stored)) {
    return stored;
  }
  return ownedIds[0]!;
}
