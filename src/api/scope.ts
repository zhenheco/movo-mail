/**
 * Mailbox access-scoping helpers for the read API.
 *
 * Every read route must guarantee a user can only ever see data belonging to a
 * mailbox they own. The authenticated identity (`AccessUser`) is matched to the
 * mailboxes it owns via `getMailboxesForUser`, and individual resources are
 * checked against that owned set before any body is returned.
 *
 * Helpers here are deliberately small and pure-ish (they only read through the
 * db contract) so route handlers stay thin and the scoping logic is unit
 * testable in isolation.
 */

import type { Env, AccessUser, Mailbox } from "../types";
import { getMailboxesForUser, getUserByEmail, getUserRole } from "../db";

export interface ResolvedViewer {
  userId: string | null;
  isAdmin: boolean;
}

/** Resolve route auth identity to the DB user id used by mailbox/thread rows. */
export async function resolveViewer(
  env: Env,
  user: AccessUser,
): Promise<ResolvedViewer> {
  const dbUser = await getUserByEmail(env, user.email);
  const role = await getUserRole(env, user.email);
  return {
    userId: dbUser?.id ?? null,
    isAdmin: role === "admin",
  };
}

/** Resolve the set of mailbox ids the authenticated user is allowed to read. */
export async function getOwnedMailboxIds(
  env: Env,
  user: AccessUser,
): Promise<ReadonlySet<string>> {
  const mailboxes = await getMailboxesForUser(env, user.email);
  return new Set(mailboxes.map((m: Mailbox) => m.id));
}

/** True when the user owns the given mailbox id. */
export async function userOwnsMailbox(
  env: Env,
  user: AccessUser,
  mailboxId: string,
): Promise<boolean> {
  const owned = await getOwnedMailboxIds(env, user);
  return owned.has(mailboxId);
}
