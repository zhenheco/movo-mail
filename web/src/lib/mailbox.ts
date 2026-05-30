/**
 * Resolve the active mailbox id.
 *
 * The read API scopes everything to a mailbox id but exposes no mailbox-listing
 * endpoint, so the active mailbox is sourced (in priority order) from:
 *   1. the `?mailbox=` URL query (handy for switching / debugging), then
 *   2. the build-time `VITE_DEFAULT_MAILBOX` env var.
 * Returns null when none is configured so the UI can show a clear message
 * instead of firing requests that would 400.
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
 * Resolve the From address for outbound sends. There is no mailbox-listing
 * endpoint, so this comes from `VITE_DEFAULT_FROM` (an email like
 * `name@movo.com.my`), falling back to the mailbox id when that already looks
 * like an address.
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
