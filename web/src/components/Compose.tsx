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
import { buildSendRequest } from "../lib/compose";
import { aiDraft, sendMessage, type MailboxSummary } from "../lib/api";
import { isLikelyEmail, parseRecipientInput } from "../lib/format";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Spinner } from "./ui/feedback";

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

export function Compose({
  fromAddress,
  initial,
  fromOptions,
  onClose,
  onSent,
}: ComposeProps) {
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const [to, setTo] = useState(initial.to);
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
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
                  {b.displayName ? `${b.displayName} <${b.address}>` : b.address}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-xs text-muted-foreground">
            From <span className="font-medium">{effectiveFromAddress}</span>
          </p>
        )}

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

        <label className="sr-only" htmlFor="compose-subject">
          Subject
        </label>
        <Input
          id="compose-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject"
        />

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
