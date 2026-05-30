/**
 * Inbound Email Worker handler.
 *
 * Invoked from the Worker's `email()` export (via ctx.waitUntil). Reads the raw
 * message, parses it with postal-mime (see ./parse), archives the raw .eml and
 * each attachment to R2, and indexes the normalized message into D1 through
 * src/db. It never throws out of the handler: any failure is logged so the
 * email() runtime doesn't surface an unhandled rejection.
 */

import { v4 as uuidv4 } from "uuid";
import type { Env, ParsedAttachment } from "../types";
import { getMailboxByAddress, insertInboundMessage } from "../db";
import { parseInbound } from "./parse";

/**
 * Minimal shape of the Cloudflare Email Worker message object we rely on.
 * (The full runtime type comes from @cloudflare/workers-types as
 * `ForwardableEmailMessage`; this alias keeps the contract explicit.)
 */
export type InboundEmailMessage = ForwardableEmailMessage;

/** Read a ReadableStream<Uint8Array> fully into a single Uint8Array. */
async function readRaw(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** R2 key for the archived raw .eml. */
function rawKey(id: string): string {
  return `msg/${id}.eml`;
}

/** R2 key for the nth attachment of a message. */
function attachmentKey(id: string, index: number): string {
  return `att/${id}/${index}`;
}

/** Store the raw .eml and all attachments to R2. Returns recorded R2 keys. */
async function archiveToR2(
  env: Env,
  id: string,
  raw: Uint8Array,
  attachments: ParsedAttachment[],
): Promise<{ rawR2Key: string; attachmentKeys: string[] }> {
  const rawR2Key = rawKey(id);
  await env.MAIL_R2.put(rawR2Key, raw);

  const attachmentKeys: string[] = [];
  for (let i = 0; i < attachments.length; i += 1) {
    const key = attachmentKey(id, i);
    const bytes = attachments[i]!.content;
    await env.MAIL_R2.put(key, bytes as Uint8Array);
    attachmentKeys.push(key);
  }
  return { rawR2Key, attachmentKeys };
}

/**
 * Handle a single inbound email end-to-end. Never throws.
 */
export async function handleInbound(
  message: InboundEmailMessage,
  env: Env,
): Promise<void> {
  const recipient = message.to;
  try {
    // Resolve the destination mailbox first; ignore mail to unknown addresses.
    const mailbox = await getMailboxByAddress(env, recipient);
    if (!mailbox) {
      console.warn(`[inbound] no mailbox for recipient: ${recipient}`);
      return;
    }

    const raw = await readRaw(message.raw);
    const parsed = await parseInbound(raw, mailbox.address, Date.now());

    // Mint ONE id and thread it through both sides: the R2 archive (raw .eml +
    // attachment bytes) and the D1 index. This keeps the persisted row's
    // r2_raw_key / attachment r2_key pointing at the exact objects we put,
    // instead of each side minting its own id and orphaning the bytes.
    const id = uuidv4();
    await archiveToR2(env, id, raw, parsed.attachments);

    await insertInboundMessage(env, parsed, id);
  } catch (err) {
    // Email handlers must not throw; log and swallow so the runtime can ack.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[inbound] failed to process message for ${recipient}: ${reason}`);
  }
}
