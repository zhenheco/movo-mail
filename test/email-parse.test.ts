import { describe, expect, it } from "vitest";
import { parseInbound } from "../src/email/parse";

const HTML_EML = [
  "From: Alice <alice@example.com>",
  "To: support@movo.com.my",
  "Subject: HTML body",
  "Message-ID: <html-1@example.com>",
  "Date: Fri, 30 May 2026 10:00:00 +0000",
  'Content-Type: multipart/alternative; boundary="ALT"',
  "",
  "--ALT",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "HTML fallback",
  "",
  "--ALT",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<style>.x{color:red}</style><p onclick="evil()">HTML</p><script>x()</script>',
  "",
  "--ALT--",
  "",
].join("\r\n");

describe("parseInbound", () => {
  it("stores parsed html as raw client-sanitized render input", async () => {
    const parsed = await parseInbound(
      new TextEncoder().encode(HTML_EML),
      "support@movo.com.my",
      1_700_000_000_000,
    );

    expect(parsed.html?.trim()).toBe(
      '<style>.x{color:red}</style><p onclick="evil()">HTML</p><script>x()</script>',
    );
  });
});
