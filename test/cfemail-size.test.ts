import { describe, expect, it, vi } from "vitest";

import type { Env, SendRequest } from "../src/types";
import { sendViaCfEmail } from "../src/lib/cfemail";

const MAX_RELAY_MESSAGE_BYTES = 5 * 1024 * 1024;

function makeEnv(): Env {
  return {
    DB: {} as unknown as D1Database,
    MAIL_R2: {} as unknown as R2Bucket,
    MAIL_KV: {} as unknown as KVNamespace,
    ASSETS: {} as unknown as Fetcher,
    CF_EMAIL_ENDPOINT: "https://cf-email.example.workers.dev",
    CF_EMAIL_API_KEY: "cfes_test_key",
    CF_ACCESS_AUD: "aud",
    CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    AI_API_KEY: "ai_test_key",
    FALLBACK_FORWARD: "fallback@movo.com.my",
  };
}

function baseRequest(overrides: Partial<SendRequest> = {}): SendRequest {
  return {
    from: { address: "alice@movo.com.my" },
    to: [{ address: "bob@example.com" }],
    subject: "Size boundary",
    text: "hello",
    ...overrides,
  };
}

function stubRelay() {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ id: "relay-1", status: "sent" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("sendViaCfEmail serialized message size guard", () => {
  it("rejects a UTF-8 body whose complete serialized message exceeds 5 MiB", async () => {
    const fetchMock = stubRelay();
    const oversizedUtf8Body = "😀".repeat(
      Math.ceil((MAX_RELAY_MESSAGE_BYTES + 1) / 4),
    );

    await expect(
      sendViaCfEmail(makeEnv(), baseRequest({ text: oversizedUtf8Body })),
    ).rejects.toMatchObject({
      status: 400,
      relayStatus: "message_size_limit",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts attachment MIME overhead and normalized Base64 in the same hard limit", async () => {
    const fetchMock = stubRelay();
    const base64AtAttachmentBoundary = "A".repeat(MAX_RELAY_MESSAGE_BYTES);

    await expect(
      sendViaCfEmail(
        makeEnv(),
        baseRequest({
          text: "body",
          attachments: [
            {
              filename: "boundary.bin",
              contentType: "application/octet-stream",
              contentBase64: base64AtAttachmentBoundary,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      relayStatus: "message_size_limit",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing id", { status: "sent" }],
    ["missing status", { id: "relay-1" }],
    ["unknown status", { id: "relay-1", status: "accepted" }],
  ])("rejects a 2xx relay response with %s", async (_label, payload) => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendViaCfEmail(makeEnv(), baseRequest())).rejects.toMatchObject({
      name: "CfEmailError",
      status: 200,
      relayStatus: "invalid_response",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
