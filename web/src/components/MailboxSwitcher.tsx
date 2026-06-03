/**
 * Account-style mailbox switcher for users who own more than one mailbox.
 *
 * The backend already scopes reads + sends by mailbox OWNERSHIP (one Gmail can
 * own several @movo.com.my addresses); this is the missing UI that lets the
 * owner pick which owned mailbox is active. The chosen mailbox drives both the
 * inbox (ThreadList) and the Compose From address upstream in App.
 *
 * A native <select> keeps it accessible + dependency-free and styled to match
 * the movo UI. The caller renders this only when there is a real choice to make
 * (>1 owned mailbox), so a single-mailbox user sees nothing new.
 */

import type { MailboxSummary } from "../lib/api";

export interface MailboxSwitcherProps {
  /** The caller's owned mailboxes (the switch options). */
  mailboxes: MailboxSummary[];
  /** Currently active mailbox id. */
  activeId: string;
  /** Switch the active mailbox. */
  onSwitch: (id: string) => void;
}

/** Label for an option: "Display Name <addr>" or just the address. */
function optionLabel(mailbox: MailboxSummary): string {
  return mailbox.displayName
    ? `${mailbox.displayName} <${mailbox.address}>`
    : mailbox.address;
}

export function MailboxSwitcher({
  mailboxes,
  activeId,
  onSwitch,
}: MailboxSwitcherProps) {
  return (
    <label className="flex flex-col gap-1 px-3 pb-3">
      <span className="text-xs font-medium text-muted-foreground">Mailbox</span>
      <select
        value={activeId}
        onChange={(e) => onSwitch(e.target.value)}
        aria-label="Active mailbox"
        className="w-full truncate rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
      >
        {mailboxes.map((mailbox) => (
          <option key={mailbox.id} value={mailbox.id}>
            {optionLabel(mailbox)}
          </option>
        ))}
      </select>
    </label>
  );
}
