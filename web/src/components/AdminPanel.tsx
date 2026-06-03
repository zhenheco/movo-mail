/**
 * Admin settings panel — self-service mailbox management.
 *
 * Lists every managed mailbox, lets an admin add one (a pure D1 write: the
 * catch-all already routes every address to the worker, so a new row starts
 * being stored immediately) and delete one (with a confirm step). After any
 * add/delete the list is refetched so the table always reflects D1.
 *
 * Errors are surfaced verbatim from ApiError (e.g. 409 duplicate, 400 bad
 * address) so the admin sees the server's friendly reason.
 */

import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  createAdminMailbox,
  deleteAdminMailbox,
  fetchAdminMailboxes,
  type AdminMailbox,
} from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { EmptyState, ErrorState, LoadingState } from "./ui/feedback";

export interface AdminPanelProps {
  /** Close the panel and return to the inbox. */
  onClose: () => void;
}

export function AdminPanel({ onClose }: AdminPanelProps) {
  const listState = useAsync<AdminMailbox[]>(
    () => fetchAdminMailboxes(),
    [],
  );

  return (
    <div
      aria-label="Mailbox administration"
      className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-6">
        <h1 className="text-base font-semibold">Mailbox settings</h1>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Back to inbox
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
          <AddMailboxForm onAdded={listState.reload} />
          <MailboxTable state={listState} onChanged={listState.reload} />
        </div>
      </div>
    </div>
  );
}

// ── Add form ─────────────────────────────────────────────────────────────────

function AddMailboxForm({ onAdded }: { onAdded: () => void }) {
  const [address, setAddress] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setAddress("");
    setOwnerEmail("");
    setDisplayName("");
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) {
      return;
    }
    const trimmedAddress = address.trim();
    const trimmedOwner = ownerEmail.trim();
    const trimmedName = displayName.trim();
    if (!trimmedAddress || !trimmedOwner) {
      setError("Address and owner email are required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createAdminMailbox({
        address: trimmedAddress,
        ownerEmail: trimmedOwner,
        ...(trimmedName ? { displayName: trimmedName } : {}),
      });
      reset();
      onAdded();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : "We could not add the mailbox. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h2 className="text-sm font-semibold">Add a mailbox</h2>
      <p className="text-xs text-muted-foreground">
        New addresses start receiving mail immediately — no DNS or routing change
        needed.
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Address</span>
          <Input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="sales@movo.com.my"
            aria-label="Mailbox address"
            autoComplete="off"
            disabled={submitting}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Owner login email</span>
          <span className="text-xs text-muted-foreground">
            The email they sign in to Cloudflare Access with (their Google/Gmail)
            — not the @movo.com.my address.
          </span>
          <Input
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
            placeholder="owner@gmail.com"
            aria-label="Owner login email"
            autoComplete="off"
            disabled={submitting}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">
            Display name <span className="text-muted-foreground">(optional)</span>
          </span>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Sales Team"
            aria-label="Display name"
            autoComplete="off"
            disabled={submitting}
          />
        </label>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={submitting}>
            {submitting ? "Adding…" : "Add mailbox"}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ── Table ────────────────────────────────────────────────────────────────────

function MailboxTable({
  state,
  onChanged,
}: {
  state: ReturnType<typeof useAsync<AdminMailbox[]>>;
  onChanged: () => void;
}) {
  if (state.loading) {
    return <LoadingState label="Loading mailboxes…" />;
  }
  if (state.error) {
    return <ErrorState message={state.error} onRetry={state.reload} />;
  }
  const mailboxes = state.data ?? [];
  if (mailboxes.length === 0) {
    return <EmptyState message="No mailboxes yet. Add one above." />;
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Managed mailboxes</h2>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Address</th>
              <th className="px-4 py-2 font-medium">Owner</th>
              <th className="px-4 py-2 font-medium">Display name</th>
              <th className="px-4 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {mailboxes.map((mailbox) => (
              <MailboxRow
                key={mailbox.id}
                mailbox={mailbox}
                onDeleted={onChanged}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MailboxRow({
  mailbox,
  onDeleted,
}: {
  mailbox: AdminMailbox;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    if (deleting) {
      return;
    }
    const ok = window.confirm(
      `Delete mailbox ${mailbox.address}? New mail to this address will fall back to the catch-all.`,
    );
    if (!ok) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await deleteAdminMailbox(mailbox.id);
      onDeleted();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : "We could not delete the mailbox. Please try again.",
      );
      setDeleting(false);
    }
  }

  return (
    <tr>
      <td className="px-4 py-2 align-top font-medium">{mailbox.address}</td>
      <td className="px-4 py-2 align-top text-muted-foreground">
        {mailbox.ownerEmail ?? "—"}
      </td>
      <td className="px-4 py-2 align-top text-muted-foreground">
        {mailbox.displayName ?? "—"}
      </td>
      <td className="px-4 py-2 align-top text-right">
        <div className="flex flex-col items-end gap-1">
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={deleting}
            aria-label={`Delete mailbox ${mailbox.address}`}
          >
            {deleting ? "Deleting…" : "Delete"}
          </Button>
          {error ? (
            <span className="max-w-xs text-xs text-red-600">{error}</span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
