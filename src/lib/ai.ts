/**
 * AI draft-reply provider boundary (spec 6.5).
 *
 * The concrete LLM provider is hidden behind `draftReply`. Callers depend only
 * on the AiDraftRequest → AiDraftResult shape (see src/types.ts), never on any
 * Anthropic-specific detail. To swap providers, replace `callProvider` below —
 * nothing else in the codebase needs to change.
 *
 * Default provider: Anthropic Claude via the Messages API (plain fetch),
 * authenticated with env.AI_API_KEY. Model: claude-sonnet-4-6.
 *
 * This module ONLY drafts text. It never sends email (sending is owned by
 * src/lib/cfemail.ts behind POST /api/send) and never touches the database.
 */

import type { Env, AiDraftRequest, AiDraftResult } from "../types";

/** Default model id. Centralized so a future env override is a one-line change. */
const MODEL = "claude-sonnet-4-6";

/** Anthropic Messages API endpoint + version pin. */
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Bound the request: cap output tokens and how much history we feed the model. */
const MAX_TOKENS = 1024;
const MAX_HISTORY_MESSAGES = 20;
const MAX_BODY_CHARS = 4000;

/** Friendly, stable error surfaced to the API layer on any provider failure. */
const PROVIDER_ERROR = "Unable to generate a draft right now. Please try again.";

/** Minimal shape of the Anthropic Messages API response we read. */
interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
}

/** Truncate overly-long text so a single huge message can't blow the prompt. */
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Derive the reply subject from the most recent message subject in history. */
function replySubject(req: AiDraftRequest): string {
  const latest = req.history.length > 0 ? req.history[req.history.length - 1] : undefined;
  const base = (latest?.subject ?? "").trim();
  if (base.length === 0) return "Re:";
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

/** Build a plain-text transcript of the thread for the model. */
function buildTranscript(req: AiDraftRequest): string {
  const recent = req.history.slice(-MAX_HISTORY_MESSAGES);
  return recent
    .map((m) => {
      const who = m.direction === "inbound" ? "Them" : "Us";
      return `${who} <${m.from}>:\n${truncate(m.text.trim(), MAX_BODY_CHARS)}`;
    })
    .join("\n\n---\n\n");
}

/** Compose the user prompt sent to the model. */
function buildPrompt(req: AiDraftRequest): string {
  const transcript = buildTranscript(req);
  const tone = req.tone && req.tone.trim().length > 0 ? req.tone.trim() : "professional";
  const instruction =
    req.instruction && req.instruction.trim().length > 0
      ? `\n\nOperator instruction: ${req.instruction.trim()}`
      : "";
  return (
    "You are drafting a reply on behalf of a Movo (@movo.com.my) staff member.\n" +
    `Write a concise, ${tone} plain-text reply to the most recent inbound message ` +
    "in the thread below (oldest first). Do not invent facts. Output ONLY the reply " +
    "body — no subject line, no signature, no quoting of prior messages." +
    `${instruction}\n\nTranscript:\n${transcript}`
  );
}

/**
 * Provider-specific call. SWAP THIS FUNCTION to change LLM providers; the rest
 * of the module (prompt building, subject derivation, return shape) is generic.
 *
 * Returns the assistant's plain-text reply. Throws PROVIDER_ERROR on any
 * network, HTTP, parse, or empty-content failure.
 */
async function callProvider(env: Env, prompt: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.AI_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (err) {
    console.error("ai provider fetch failed", err);
    throw new Error(PROVIDER_ERROR);
  }

  if (!res.ok) {
    console.error("ai provider non-2xx", res.status);
    throw new Error(PROVIDER_ERROR);
  }

  let data: AnthropicResponse;
  try {
    data = (await res.json()) as AnthropicResponse;
  } catch (err) {
    console.error("ai provider parse failed", err);
    throw new Error(PROVIDER_ERROR);
  }

  const text = (data.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();

  if (text.length === 0) {
    console.error("ai provider returned empty content");
    throw new Error(PROVIDER_ERROR);
  }
  return text;
}

/** Escape the few characters that matter for safe HTML text rendering. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Render the plain-text reply as simple, safe paragraph HTML. */
function toHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/**
 * Generate a reply draft for a thread.
 *
 * This function NEVER sends — it only returns a draft. The caller (the AI route)
 * is responsible for guardrails (rate limit, 1:1, audit) before invoking this.
 */
export async function draftReply(
  env: Env,
  req: AiDraftRequest,
): Promise<AiDraftResult> {
  const text = await callProvider(env, buildPrompt(req));
  return {
    subject: replySubject(req),
    text,
    html: toHtml(text),
    model: MODEL,
  };
}
