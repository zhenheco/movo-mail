import type { CloudflareOptions, ErrorEvent, Event } from "@sentry/cloudflare";
import type { Env } from "./types";

type SentryEnv = Pick<
  Env,
  "SENTRY_DSN" | "SENTRY_ENVIRONMENT" | "SENTRY_RELEASE" | "SENTRY_TRACES_SAMPLE_RATE"
>;

const DEFAULT_TRACES_SAMPLE_RATE = 0.1;
const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|password|secret|token|api[-_]?key|session|email|address|message|mailbox|recipient|sender|hitpay|ai[-_]?api[-_]?key)/i;
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
  "x-api-key",
]);

function parseSampleRate(value: string | undefined): number {
  if (!value) {
    return DEFAULT_TRACES_SAMPLE_RATE;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TRACES_SAMPLE_RATE;
  }

  return Math.min(1, Math.max(0, parsed));
}

function scrubRecordValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubRecordValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[Filtered]" : scrubRecordValue(entry),
      ]),
    );
  }

  return value;
}

function scrubRequestUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split("?")[0]?.split("#")[0] ?? value;
  }
}

function scrubHeaders(headers: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? "[Filtered]" : String(value),
    ]),
  );
}

export function scrubSentryEvent<T extends Event>(event: T): T {
  const scrubbed = { ...event } as Event & {
    request?: Record<string, unknown>;
    extra?: Record<string, unknown>;
    contexts?: Record<string, unknown>;
  };

  if (scrubbed.request) {
    const request = { ...scrubbed.request };
    if (typeof request.url === "string") {
      request.url = scrubRequestUrl(request.url);
    }
    delete request.query_string;
    delete request.cookies;
    delete request.data;
    request.headers = scrubHeaders(request.headers as Record<string, unknown> | undefined);
    scrubbed.request = request;
  }

  if (scrubbed.extra) {
    scrubbed.extra = scrubRecordValue(scrubbed.extra) as Event["extra"];
  }

  if (scrubbed.contexts) {
    scrubbed.contexts = scrubRecordValue(scrubbed.contexts) as Event["contexts"];
  }

  if (scrubbed.user) {
    const id = scrubbed.user.id;
    scrubbed.user = id ? { id } : undefined;
  }

  return scrubbed as T;
}

export function buildSentryOptions(env: SentryEnv): CloudflareOptions | undefined {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) {
    return undefined;
  }

  return {
    dsn,
    environment: env.SENTRY_ENVIRONMENT ?? "production",
    release: env.SENTRY_RELEASE,
    sendDefaultPii: false,
    tracesSampleRate: parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE),
    beforeSend: (event) => scrubSentryEvent(event) as ErrorEvent,
    beforeSendTransaction: scrubSentryEvent,
  };
}
