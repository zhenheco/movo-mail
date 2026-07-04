/**
 * Compose panel: to / subject / body, an "AI draft" button, and Send.
 *
 * Behaviour rules:
 *   - AI draft calls POST /api/ai/draft and writes the result into the editable
 *     subject + body fields. It NEVER sends — the user must review and click
 *     Send. (Spec 6.5: human approval required.)
 *   - Reply pre-fills To (original sender), a "Re: " subject, and threading
 *     headers (In-Reply-To / References) so the send carries them.
 *   - Every async action has its own loading + error surface.
 */

import { useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ComposeDraft } from "../lib/compose";
import {
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_PAYLOAD_BYTES,
  buildSendRequest,
  estimatedBase64Length,
  fileToAttachment,
} from "../lib/compose";
import type { OutboundAttachment } from "../lib/types";
import { aiDraft, sendMessage, type MailboxSummary } from "../lib/api";
import { isLikelyEmail, parseRecipientInput } from "../lib/format";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Spinner } from "./ui/feedback";
import { Badge } from "./ui/badge";

export interface ComposeProps {
  /** Fallback From address (used only if the selected mailbox can't resolve). */
  fromAddress: string;
  /** Pre-filled draft (reply or blank new message). */
  initial: ComposeDraft;
  /** The caller's owned mailboxes — the From options (drives which mailbox sends). */
  fromOptions: MailboxSummary[];
  onClose: () => void;
  /** Notify parent on a successful send so it can refresh / collapse. */
  onSent: (providerId: string) => void;
}

type SendPhase = "idle" | "sending" | "error" | "sent";

function fromOptionLabel(mailbox: MailboxSummary): string {
  const label = mailbox.displayName
    ? `${mailbox.displayName} <${mailbox.address}>`
    : mailbox.address;
  return mailbox.kind === "shared" ? `${label}（共用）` : label;
}

export function Compose({
  fromAddress,
  initial,
  fromOptions,
  onClose,
  onSent,
}: ComposeProps) {
  // ── Field reference (what each piece is for; the From-cluster is the easy
  //    one to confuse, so it's spelled out) ──────────────────────────────────
  //
  //  EDITABLE form fields (what the user sees + types):
  //    to       — recipient line, comma-separated string. Parsed into
  //               `recipients` for validation/send. A reply pre-fills the
  //               original sender (initial.to).
  //    subject  — subject line. A reply pre-fills "Re: …".
  //    body     — the message text the user writes (or the AI draft fills in).
  //    From     — which owned mailbox sends (the <select> / static line below).
  //               Tracked as `fromId`, NOT a free-text field.
  //
  //  HIDDEN threading state (carried in `initial`, never shown as inputs):
  //    initial.threadId    — set ⇒ this is a REPLY. Attaches the send to that
  //                          thread, unlocks "AI draft", and locks the From box.
  //    initial.inReplyTo   — RFC-5322 In-Reply-To header (last msg's Message-ID)
  //    initial.references  — RFC-5322 References chain. Both make the reply nest
  //                          correctly in the customer's mail client.
  //    initial.history     — prior messages; fed to POST /api/ai/draft only.
  //    idempotencyKeyRef   — one UUID per open panel; dedupes a double-click /
  //                          retry so the same reply isn't sent twice.
  //
  //  The four From-* values, distinct on purpose:
  //    fromAddress           (prop)  — fallback address, used ONLY if the
  //                                    selected mailbox can't be resolved.
  //    fromId                (state) — id of the mailbox the user picked.
  //    fromBox               (deriv) — the MailboxSummary row matching fromId.
  //    effectiveFromAddress  (deriv) — fromBox.address ?? fromAddress = the
  //                                    address that actually sends.
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const [to, setTo] = useState(initial.to); // recipient line (raw string)
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [attachments, setAttachments] = useState<OutboundAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  // Which owned mailbox sends. A reply is locked to the thread's mailbox
  // (initial.mailboxId); a new message defaults to it, else the first owned.
  const [fromId, setFromId] = useState(
    initial.mailboxId ?? fromOptions[0]?.id ?? "",
  );
  const fromBox = fromOptions.find((b) => b.id === fromId);
  const effectiveFromAddress = fromBox?.address ?? fromAddress;
  const isReply = Boolean(initial.threadId);
  // A new message may pick its sender when the caller owns more than one box.
  const canPickFrom = !isReply && fromOptions.length > 1;

  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const [sendPhase, setSendPhase] = useState<SendPhase>("idle");
  const [sendError, setSendError] = useState<string | null>(null);

  const recipients = parseRecipientInput(to);
  const hasValidRecipient =
    recipients.length > 0 && recipients.every((r) => isLikelyEmail(r.address));
  const canSend =
    hasValidRecipient && subject.trim().length > 0 && sendPhase !== "sending";

  async function handleAiDraft() {
    if (!initial.threadId) {
      setAiError("AI draft is only available when replying to a thread.");
      return;
    }
    setAiLoading(true);
    setAiError(null);
    try {
      const draft = await aiDraft({
        threadId: initial.threadId,
        history: initial.history ?? [],
        instruction: undefined,
      });
      // Fill the EDITABLE fields — the user still reviews + sends manually.
      if (draft.subject.trim().length > 0) {
        setSubject(draft.subject);
      }
      setBody(draft.text);
    } catch (err) {
      setAiError(
        err instanceof Error
          ? err.message
          : "Could not generate a draft. Please try again.",
      );
    } finally {
      setAiLoading(false);
    }
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if (!canSend) {
      return;
    }
    setSendPhase("sending");
    setSendError(null);
    try {
      const payload = buildSendRequest({
        fromAddress: effectiveFromAddress,
        to: recipients,
        subject,
        text: body,
        attachments,
        threadId: initial.threadId,
        // Send from the selected mailbox; the server re-derives the From address
        // from this id (a reply stays locked to its thread's mailbox).
        mailboxId: fromId || initial.mailboxId,
        inReplyTo: initial.inReplyTo,
        references: initial.references,
      });
      const result = await sendMessage(payload, idempotencyKeyRef.current);
      setSendPhase("sent");
      onSent(result.id);
    } catch (err) {
      setSendPhase("error");
      setSendError(
        err instanceof Error ? err.message : "Failed to send. Please try again.",
      );
    }
  }

  async function handleFiles(files: FileList | null) {
    setAttachmentError(null);
    if (!files || files.length === 0) {
      setAttachments([]);
      return;
    }
    const selected = Array.from(files);
    if (selected.length > MAX_ATTACHMENT_COUNT) {
      setAttachments([]);
      setAttachmentError(`Attach up to ${MAX_ATTACHMENT_COUNT} files.`);
      return;
    }
    const estimatedPayload = selected.reduce(
      (total, file) => total + estimatedBase64Length(file.size),
      0,
    );
    if (estimatedPayload > MAX_ATTACHMENT_PAYLOAD_BYTES) {
      setAttachments([]);
      setAttachmentError("Attachments must be 5 MiB or less.");
      return;
    }
    try {
      setAttachments(await Promise.all(selected.map(fileToAttachment)));
    } catch {
      setAttachments([]);
      setAttachmentError("Could not read the selected attachment.");
    }
  }

  function clearAttachments() {
    setAttachments([]);
    setAttachmentError(null);
    if (attachmentInputRef.current) {
      attachmentInputRef.current.value = "";
    }
  }

  return (
    <footer
      aria-label="Compose"
      className="border-t border-border bg-background"
    >
      <form onSubmit={handleSend} className="flex flex-col gap-2 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            {initial.threadId ? "Reply" : "New message"}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close compose"
          >
            Close
          </Button>
        </div>

        {/* From — sending mailbox. New message w/ >1 mailbox: editable <select>;
            otherwise (incl. every reply) a fixed line locked to fromId. */}
        {canPickFrom ? (
          <label className="flex items-center gap-2 text-xs">
            <span className="font-medium text-muted-foreground">From</span>
            <select
              value={fromId}
              onChange={(e) => setFromId(e.target.value)}
              aria-label="Send from mailbox"
              className="flex-1 truncate rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
            >
              {fromOptions.map((b) => (
                <option key={b.id} value={b.id}>
                  {fromOptionLabel(b)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            From <span className="font-medium">{effectiveFromAddress}</span>
            {fromBox?.kind === "shared" ? <Badge variant="shared">共用</Badge> : null}
          </p>
        )}

        {/* To — recipient line (comma-separated). Reply pre-fills the original
            sender; parsed into `recipients` for validation. */}
        <label className="sr-only" htmlFor="compose-to">
          Recipients
        </label>
        <Input
          id="compose-to"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="To (comma-separated)"
          aria-invalid={to.length > 0 && !hasValidRecipient}
        />

        {/* Subject — reply pre-fills "Re: …"; required to enable Send. */}
        <label className="sr-only" htmlFor="compose-subject">
          Subject
        </label>
        <Input
          id="compose-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject"
        />

        {/* Body — message text the user writes, or the AI draft fills in. */}
        <label className="sr-only" htmlFor="compose-body">
          Message body
        </label>
        <Textarea
          id="compose-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your message…"
          rows={6}
        />

        <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs">
          <span className="truncate text-muted-foreground">
            {attachments.length > 0
              ? `${attachments.length} attachment${attachments.length === 1 ? "" : "s"} selected`
              : "Attach files"}
          </span>
          <Input
            ref={attachmentInputRef}
            type="file"
            multiple
            className="max-w-48 text-xs"
            onChange={(e) => void handleFiles(e.currentTarget.files)}
          />
        </label>

        {attachments.length > 0 ? (
          <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
            <ul className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
              {attachments.map((att, index) => (
                <li
                  key={`${att.filename}:${index}`}
                  className="truncate"
                  title={att.filename}
                >
                  {att.filename}
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearAttachments}
              className="h-7 px-2 text-xs"
            >
              Clear
            </Button>
          </div>
        ) : null}

        {aiError ? (
          <p role="alert" className="text-xs text-red-600">
            {aiError}
          </p>
        ) : null}
        {sendError ? (
          <p role="alert" className="text-xs text-red-600">
            {sendError}
          </p>
        ) : null}
        {attachmentError ? (
          <p role="alert" className="text-xs text-red-600">
            {attachmentError}
          </p>
        ) : null}
        {sendPhase === "sent" ? (
          <p role="status" className="text-xs text-green-600">
            Message sent.
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAiDraft}
            disabled={aiLoading || !initial.threadId}
            title={
              initial.threadId
                ? "Generate a draft reply with AI"
                : "AI draft is available when replying"
            }
          >
            {aiLoading ? <Spinner /> : null}
            AI draft
          </Button>

          <Button type="submit" size="sm" disabled={!canSend}>
            {sendPhase === "sending" ? <Spinner /> : null}
            Send
          </Button>
        </div>
      </form>
    </footer>
  );
}
