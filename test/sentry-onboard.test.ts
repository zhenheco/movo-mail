import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import packageJson from "../package.json";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Sentry onboarding", () => {
  it("declares the Cloudflare Sentry SDK dependency", () => {
    expect(packageJson.dependencies?.["@sentry/cloudflare"]).toBeDefined();
  });

  it("wraps the Worker fetch handler with Sentry", () => {
    const indexSource = read("src/index.ts");

    expect(indexSource).toContain("@sentry/cloudflare");
    expect(indexSource).toContain("Sentry.withSentry");
    expect(indexSource).toContain("buildSentryOptions");
    expect(indexSource).toContain("app.onError");
    expect(indexSource).toContain("Sentry.captureException");
  });

  it("declares only non-secret Sentry vars in Wrangler config", () => {
    const wranglerSource = read("wrangler.toml");

    expect(wranglerSource).toContain('SENTRY_ENVIRONMENT = "production"');
    expect(wranglerSource).toContain('SENTRY_TRACES_SAMPLE_RATE = "0.1"');
    expect(wranglerSource).not.toMatch(/SENTRY_DSN\s*=/);
  });

  it("provides Sentry options with PII scrubbing", async () => {
    const { buildSentryOptions, scrubSentryEvent } = await import("../src/sentry");
    const options = buildSentryOptions({
      SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      SENTRY_ENVIRONMENT: "production",
      SENTRY_RELEASE: "movo-mail@abc123",
      SENTRY_TRACES_SAMPLE_RATE: "0.25",
    });

    expect(options).toBeDefined();
    if (!options) {
      throw new Error("expected Sentry options when SENTRY_DSN is configured");
    }
    expect(options).toMatchObject({
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      release: "movo-mail@abc123",
      sendDefaultPii: false,
      tracesSampleRate: 0.25,
    });
    expect(options.beforeSend).toBeTypeOf("function");
    expect(options.beforeSendTransaction).toBe(scrubSentryEvent);

    const scrubbed = scrubSentryEvent({
      request: {
        url: "https://mail.movo.com.my/api/send?token=secret&email=a@movo.com.my",
        query_string: "token=secret&email=a@movo.com.my",
        cookies: { sid: "secret" },
        headers: {
          authorization: "Bearer secret",
          cookie: "sid=secret",
          "cf-access-jwt-assertion": "jwt.secret",
          "cf-connecting-ip": "203.0.113.10",
          referer: "https://mail.movo.com.my/inbox?mailbox=support@movo.com.my#message",
          "x-session-token": "secret",
          accept: "application/json",
        },
        data: { to: "guest@example.com", body: "hello" },
      },
      extra: {
        apiKey: "secret",
        nested: { token: "secret", keep: "ok" },
      },
      user: {
        id: "usr_1",
        email: "alice@movo.com.my",
        ip_address: "203.0.113.10",
      },
    });

    expect(scrubbed.request?.url).toBe("https://mail.movo.com.my/api/send");
    expect(scrubbed.request?.query_string).toBeUndefined();
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.data).toBeUndefined();
    expect(scrubbed.request?.headers).toEqual({
      authorization: "[Filtered]",
      cookie: "[Filtered]",
      "cf-access-jwt-assertion": "[Filtered]",
      "cf-connecting-ip": "[Filtered]",
      referer: "https://mail.movo.com.my/inbox",
      "x-session-token": "[Filtered]",
      accept: "application/json",
    });
    expect(scrubbed.extra).toEqual({
      apiKey: "[Filtered]",
      nested: { token: "[Filtered]", keep: "ok" },
    });
    expect(scrubbed.user).toEqual({ id: "usr_1" });

    const transaction = scrubSentryEvent({
      request: {
        url: "https://mail.movo.com.my/api/search?q=guest&mailbox=support@movo.com.my",
      },
      contexts: {
        trace: {
          data: {
            "url.full": "https://mail.movo.com.my/api/search?q=guest",
            "url.query": "q=guest",
          },
        },
      },
      spans: [
        {
          data: {
            "url.full": "https://mail.movo.com.my/api/threads?mailbox=support@movo.com.my",
            "url.query": "mailbox=support@movo.com.my",
            "http.url": "https://mail.movo.com.my/api/send?token=secret",
            safe: "ok",
          },
        },
      ],
    } as never) as {
      request?: { url?: string };
      contexts?: { trace?: { data?: Record<string, unknown> } };
      spans?: Array<{ data?: Record<string, unknown> }>;
    };

    expect(transaction.request?.url).toBe("https://mail.movo.com.my/api/search");
    expect(transaction.contexts?.trace?.data).toEqual({
      "url.full": "https://mail.movo.com.my/api/search",
      "url.query": "[Filtered]",
    });
    expect(transaction.spans?.[0]?.data).toEqual({
      "url.full": "https://mail.movo.com.my/api/threads",
      "url.query": "[Filtered]",
      "http.url": "https://mail.movo.com.my/api/send",
      safe: "ok",
    });
  });
});
