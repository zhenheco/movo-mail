/**
 * Tests for the welcome / activation email module (src/lib/welcome.ts).
 *
 * `buildWelcomeEmail` is pure → asserted directly. `sendWelcomeEmail` delegates
 * to the cf-email relay (sendViaCfEmail), which is mocked here. The key contract
 * (World-B identity model): the recipient is the owner's PERSONAL login email
 * (their Google/Gmail), NOT the new @movo.com.my address, and the sender is the
 * fixed no-reply system address.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Env, SendRequest } from "../src/types";

// ── mock the only outbound path (cf-email relay) ────────────────────────────
const sendViaCfEmail = vi.fn(
  async (..._args: unknown[]) => ({ id: "relay-1", status: "sent" }),
);
vi.mock("../src/lib/cfemail", () => ({
  sendViaCfEmail: (...a: unknown[]) => sendViaCfEmail(...a),
  CfEmailError: class CfEmailError extends Error {},
}));

// imported AFTER vi.mock so the module picks up the mocked relay
const { buildWelcomeEmail, sendWelcomeEmail } = await import("../src/lib/welcome");

const fakeEnv = (): Env => ({}) as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

// ── buildWelcomeEmail (pure) ────────────────────────────────────────────────
describe("buildWelcomeEmail", () => {
  const built = () =>
    buildWelcomeEmail({
      address: "sales@movo.com.my",
      displayName: "Sales Team",
      ownerEmail: "owner@gmail.com",
      loginUrl: "https://mail.example.com",
    });

  it("subject names the new mailbox address", () => {
    expect(built().subject).toContain("sales@movo.com.my");
  });

  it("html and text both carry login URL, owner login email, and mailbox address", () => {
    const { html, text } = built();
    for (const body of [html, text]) {
      expect(body).toContain("https://mail.example.com");
      expect(body).toContain("owner@gmail.com");
      expect(body).toContain("sales@movo.com.my");
    }
  });

  it("text body has no HTML tags", () => {
    expect(built().text).not.toMatch(/<[a-z][\s\S]*>/i);
  });
});

// ── sendWelcomeEmail (relay delegation) ─────────────────────────────────────
describe("sendWelcomeEmail", () => {
  it("sends to the owner login email from the no-reply system address", async () => {
    await sendWelcomeEmail(fakeEnv(), {
      address: "sales@movo.com.my",
      displayName: "Sales Team",
      ownerEmail: "owner@gmail.com",
      loginUrl: "https://mail.example.com",
    });

    expect(sendViaCfEmail).toHaveBeenCalledTimes(1);
    const [, req] = sendViaCfEmail.mock.calls[0] as unknown as [Env, SendRequest];
    expect(req.to).toEqual([{ address: "owner@gmail.com" }]);
    expect(req.from.address).toBe("no-reply@movo.com.my");
    expect(req.subject).toContain("sales@movo.com.my");
    expect(typeof req.html).toBe("string");
    expect(typeof req.text).toBe("string");
  });

  it("propagates relay errors (the admin route swallows them best-effort)", async () => {
    sendViaCfEmail.mockRejectedValueOnce(new Error("relay down"));
    await expect(
      sendWelcomeEmail(fakeEnv(), {
        address: "x@movo.com.my",
        displayName: null,
        ownerEmail: "o@gmail.com",
        loginUrl: "https://m",
      }),
    ).rejects.toThrow();
  });
});
