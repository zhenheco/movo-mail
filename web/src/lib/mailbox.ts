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
