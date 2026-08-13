/**
 * Compose panel for new messages, sender-only replies, and explicit Reply All.
 * All editable recipient buckets remain visible so Cc/Bcc semantics are never
 * hidden behind a generic recipient input.
 */

import { useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ComposeDraft } from "../lib/compose";
import {
  ATTACHMENT_EMPTY_ERROR,
  MAX_ATTACHMENT_COUNT,
  MAX_RECIPIENT_COUNT,
  UNAVAILABLE_BCC_CONFIRMATION,
  attachmentPayloadLength,
  buildSendRequest,
  estimatedBase64Length,
  fileToAttachment,
  validateAttachmentSelection,
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
  /** The caller's sendable mailboxes — the From options. */
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
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const [to, setTo] = useState(initial.to);
  const [cc, setCc] = useState(initial.cc ?? "");
  const [bcc, setBcc] = useState(initial.bcc ?? "");
  const [bccConfirmation, setBccConfirmation] = useState(
    initial.bccConfirmation,
  );
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [attachments, setAttachments] = useState<OutboundAttachment[]>(
    initial.attachments ?? [],
  );
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const attachmentBusyRef = useRef(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  const [fromId, setFromId] = useState(
    initial.mailboxId ?? fromOptions[0]?.id ?? "",
  );
  const fromBox = fromOptions.find((mailbox) => mailbox.id === fromId);
  const effectiveFromAddress = fromBox?.address ?? fromAddress;
  const isReply = Boolean(initial.threadId);
  const isReplyAll = initial.mode === "reply-all";
  const canPickFrom = !isReply && fromOptions.length > 1;

  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [sendPhase, setSendPhase] = useState<SendPhase>("idle");
  const [sendError, setSendError] = useState<string | null>(null);

  const toRecipients = parseRecipientInput(to);
  const ccRecipients = parseRecipientInput(cc);
  const bccRecipients = parseRecipientInput(bcc);
  const recipientCount =
    toRecipients.length + ccRecipients.length + bccRecipients.length;
  const hasValidTo =
    toRecipients.length > 0 &&
    toRecipients.every((recipient) => isLikelyEmail(recipient.address));
  const hasValidCc = ccRecipients.every((recipient) =>
    isLikelyEmail(recipient.address),
  );
  const hasValidBcc = bccRecipients.every((recipient) =>
    isLikelyEmail(recipient.address),
  );
  const withinRecipientLimit = recipientCount <= MAX_RECIPIENT_COUNT;
  const bccUnavailable =
    isReplyAll && initial.bccProvenance === "unavailable";
  const bccConfirmationReady =
    !bccUnavailable ||
    (bccConfirmation === UNAVAILABLE_BCC_CONFIRMATION &&
      bccRecipients.length > 0 &&
      hasValidBcc);
  const hasValidBody = body.trim().length > 0;
  const canSend =
    hasValidTo &&
    hasValidCc &&
    hasValidBcc &&
    withinRecipientLimit &&
    hasValidBody &&
    bccConfirmationReady &&
    sendPhase !== "sending" &&
    !attachmentBusy &&
    !attachmentError;

  const recipientError =
    to.trim().length > 0 && !hasValidTo
      ? "請輸入有效的收件者地址。"
      : cc.trim().length > 0 && !hasValidCc
        ? "請輸入有效的副本地址。"
        : bcc.trim().length > 0 && !hasValidBcc
          ? "請輸入有效的密件副本地址。"
          : !withinRecipientLimit
            ? `收件者總數不可超過 ${MAX_RECIPIENT_COUNT} 位。`
            : null;

  async function handleAiDraft() {
    if (!initial.threadId) {
      setAiError("AI 草稿只適用於回覆郵件。");
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
      if (draft.subject.trim().length > 0) {
        setSubject(draft.subject);
      }
      setBody(draft.text);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "無法產生 AI 草稿。請稍後再試。");
    } finally {
      setAiLoading(false);
    }
  }

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    if (!canSend) {
      return;
    }
    setSendPhase("sending");
    setSendError(null);
    try {
      const payload = buildSendRequest({
        fromAddress: effectiveFromAddress,
        to: toRecipients,
        cc: ccRecipients,
        bcc: bccRecipients,
        subject,
        text: body,
        attachments,
        mode: initial.mode,
        bccProvenance: initial.bccProvenance,
        bccConfirmation,
        idempotencyKey: idempotencyKeyRef.current,
        threadId: initial.threadId,
        mailboxId: fromId || initial.mailboxId,
        inReplyTo: initial.inReplyTo,
        references: initial.references,
      });
      const result = await sendMessage(payload, idempotencyKeyRef.current);
      setSendPhase("sent");
      onSent(result.id);
    } catch (err) {
      setSendPhase("error");
      setSendError(err instanceof Error ? err.message : "寄信失敗，請稍後再試。");
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) {
      return;
    }
    if (attachmentBusyRef.current) {
      setAttachmentError("請先等待目前的附件讀取完成。");
      clearAttachmentInput();
      return;
    }

    const selected = Array.from(files);
    const incomingPayloadLengths = selected.map((file) =>
      estimatedBase64Length(file.size),
    );
    const selectionError = validateAttachmentSelection(
      attachments.length,
      incomingPayloadLengths,
      attachmentPayloadLength(attachments),
    );
    if (selectionError) {
      setAttachmentError(selectionError);
      clearAttachmentInput();
      return;
    }

    setAttachmentError(null);
    attachmentBusyRef.current = true;
    setAttachmentBusy(true);
    try {
      const added = await Promise.all(selected.map(fileToAttachment));
      const actualError = validateAttachmentSelection(
        attachments.length,
        added.map((attachment) => attachment.contentBase64.length),
        attachmentPayloadLength(attachments),
      );
      if (actualError) {
        setAttachmentError(actualError);
        return;
      }
      setAttachments((current) => [...current, ...added]);
    } catch (err) {
      setAttachmentError(
        err instanceof Error && err.message === ATTACHMENT_EMPTY_ERROR
          ? ATTACHMENT_EMPTY_ERROR
          : "無法讀取所選附件。",
      );
    } finally {
      attachmentBusyRef.current = false;
      setAttachmentBusy(false);
      clearAttachmentInput();
    }
  }

  function clearAttachmentInput() {
    if (attachmentInputRef.current) {
      attachmentInputRef.current.value = "";
    }
  }

  function removeAttachment(index: number) {
    setAttachments((current) => current.filter((_, i) => i !== index));
    setAttachmentError(null);
    clearAttachmentInput();
  }

  function clearAttachments() {
    setAttachments([]);
    setAttachmentError(null);
    setAttachmentBusy(false);
    attachmentBusyRef.current = false;
    clearAttachmentInput();
  }

  const heading = isReplyAll ? "全部回覆" : isReply ? "回覆" : "新郵件";

  return (
    <footer aria-label="寫信" className="border-t border-border bg-background">
      <form onSubmit={handleSend} className="flex flex-col gap-2 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{heading}</h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="關閉寫信"
          >
            關閉
          </Button>
        </div>

        {canPickFrom ? (
          <label className="flex items-center gap-2 text-xs">
            <span className="font-medium text-muted-foreground">寄件者</span>
            <select
              value={fromId}
              onChange={(event) => setFromId(event.target.value)}
              aria-label="選擇寄件信箱"
              className="flex-1 truncate rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
            >
              {fromOptions.map((mailbox) => (
                <option key={mailbox.id} value={mailbox.id}>
                  {fromOptionLabel(mailbox)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            寄件者 <span className="font-medium">{effectiveFromAddress}</span>
            {fromBox?.kind === "shared" ? <Badge variant="shared">共用</Badge> : null}
          </p>
        )}

        <label className="sr-only" htmlFor="compose-to">
          收件者
        </label>
        <Input
          id="compose-to"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder="收件者（以逗號分隔）"
          aria-label="收件者"
          aria-invalid={to.length > 0 && !hasValidTo}
          aria-describedby={recipientError ? "compose-recipient-error" : undefined}
        />

        <label className="sr-only" htmlFor="compose-cc">
          副本
        </label>
        <Input
          id="compose-cc"
          value={cc}
          onChange={(event) => setCc(event.target.value)}
          placeholder="副本（Cc，以逗號分隔）"
          aria-label="副本"
          aria-invalid={cc.length > 0 && !hasValidCc}
          aria-describedby={recipientError ? "compose-recipient-error" : undefined}
        />

        <label className="sr-only" htmlFor="compose-bcc">
          密件副本
        </label>
        <Input
          id="compose-bcc"
          value={bcc}
          onChange={(event) => setBcc(event.target.value)}
          placeholder="密件副本（Bcc，以逗號分隔）"
          aria-label="密件副本"
          aria-invalid={bcc.length > 0 && !hasValidBcc}
          aria-describedby={recipientError ? "compose-recipient-error" : undefined}
        />

        {bccUnavailable ? (
          <div
            role="note"
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
          >
            <p>
              原始密件副本無法驗證。請確認後，在上方「密件副本」欄位手動輸入至少一位收件者，系統才會允許寄出。
            </p>
            <label className="mt-2 flex items-start gap-2">
              <Input
                type="checkbox"
                checked={bccConfirmation === UNAVAILABLE_BCC_CONFIRMATION}
                onChange={(event) =>
                  setBccConfirmation(
                    event.target.checked
                      ? UNAVAILABLE_BCC_CONFIRMATION
                      : undefined,
                  )
                }
                aria-label="確認原始密件副本無法驗證"
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span>
                我確認原始密件副本無法驗證，並會手動補上密件副本收件者。
                <span className="sr-only">
                  確認值：{UNAVAILABLE_BCC_CONFIRMATION}
                </span>
              </span>
            </label>
          </div>
        ) : null}

        <label className="sr-only" htmlFor="compose-subject">
          主旨
        </label>
        <Input
          id="compose-subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="主旨"
          aria-label="主旨"
        />

        <label className="sr-only" htmlFor="compose-body">
          郵件內容
        </label>
        <Textarea
          id="compose-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="輸入郵件內容…"
          aria-label="郵件內容"
          rows={6}
        />

        <label className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border px-3 py-2 text-xs">
          <span className="truncate text-muted-foreground">
            {attachmentBusy
              ? "正在讀取附件…"
              : `新增附件（${attachments.length}/${MAX_ATTACHMENT_COUNT}）`}
          </span>
          <Input
            ref={attachmentInputRef}
            type="file"
            multiple
            aria-label={`新增附件，最多 ${MAX_ATTACHMENT_COUNT} 個`}
            className="max-w-48 text-xs"
            onChange={(event) => void handleFiles(event.currentTarget.files)}
          />
        </label>

        {attachments.length > 0 ? (
          <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
            <ul className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
              {attachments.map((attachment, index) => (
                <li
                  key={`${attachment.filename}:${index}`}
                  className="flex items-center justify-between gap-2"
                  title={attachment.filename}
                >
                  <span className="truncate">{attachment.filename}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeAttachment(index)}
                    disabled={attachmentBusy}
                    className="h-7 shrink-0 px-2 text-xs"
                    aria-label={`移除附件 ${attachment.filename}`}
                  >
                    移除
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearAttachments}
              disabled={attachmentBusy}
              className="h-7 px-2 text-xs"
            >
              清除全部
            </Button>
          </div>
        ) : null}

        {recipientError ? (
          <p id="compose-recipient-error" role="alert" className="text-xs text-red-600">
            {recipientError}
          </p>
        ) : null}
        {!hasValidBody && body.length > 0 ? (
          <p role="alert" className="text-xs text-red-600">
            請輸入郵件內容。
          </p>
        ) : null}
        {attachmentError ? (
          <div className="flex items-center justify-between gap-2">
            <p role="alert" className="text-xs text-red-600">
              {attachmentError}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAttachmentError(null)}
              aria-label="清除附件錯誤"
            >
              知道了
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
        {sendPhase === "sent" ? (
          <p role="status" className="text-xs text-green-600">
            郵件已送出。
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAiDraft}
            disabled={aiLoading || !initial.threadId}
            aria-label="產生 AI 草稿"
            title={initial.threadId ? "產生回覆草稿" : "回覆郵件時才能使用 AI 草稿"}
          >
            {aiLoading ? <Spinner /> : null}
            AI 草稿
          </Button>

          <Button type="submit" size="sm" disabled={!canSend}>
            {sendPhase === "sending" ? <Spinner /> : null}
            寄出
          </Button>
        </div>
      </form>
    </footer>
  );
}
