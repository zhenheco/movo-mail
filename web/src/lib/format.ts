/**
 * Small pure formatting/parsing helpers shared across views.
 * Kept pure (no DOM, no fetch) so they are trivially unit-testable.
 */

import type { EmailAddress } from "./types";

/** Parse a JSON-encoded string[] address column, tolerating null/garbage. */
export function parseAddresses(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
    // Some rows may store a bare address string rather than a JSON array.
    if (typeof parsed === "string") {
      return [parsed];
    }
    return [];
  } catch {
    // Not JSON — treat the raw value as a single comma-separated list.
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
}

/** Display name for a sender: prefer the name, else the address. */
export function displaySender(name: string | null, address: string): string {
  const trimmed = name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : address;
}

/** Format an epoch-ms timestamp as a short, locale-aware string. */
export function formatDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "";
  }
  const date = new Date(ms);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  try {
    if (sameDay) {
      return date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Build the "Re: ..." subject for a reply, avoiding double-prefixing.
 * Pure helper so Compose pre-fill logic stays testable.
 */
export function replySubject(subject: string | null): string {
  const base = (subject ?? "").trim();
  if (base.length === 0) {
    return "Re:";
  }
  if (/^re:/i.test(base)) {
    return base;
  }
  return `Re: ${base}`;
}

/** Format a recipient list into a single comma-separated input value. */
export function joinAddresses(addresses: EmailAddress[]): string {
  return addresses.map((a) => a.address).join(", ");
}

/**
 * Parse a free-text recipient field ("a@x.com, b@y.com") into EmailAddress[].
 * Empty/blank entries are dropped. Pure + testable.
 */
export function parseRecipientInput(value: string): EmailAddress[] {
  return value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((address) => ({ address }));
}

/** Naive but safe email validity check for client-side guardrails. */
export function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
