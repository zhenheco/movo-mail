/**
 * Welcome / activation email for a newly provisioned mailbox.
 *
 * Sent (best-effort) by POST /admin/mailboxes right after the D1 row is created.
 * The recipient is the owner's PERSONAL login email (their Google/Gmail) — the
 * address they sign into Cloudflare Access with — NOT the new @movo.com.my
 * address, which has no external delivery to the person (they read it inside the
 * webmail). This mirrors the World-B identity model: login email ≠ mailbox.
 *
 * Transport goes through the shared cf-email relay (src/lib/cfemail), the only
 * outbound path. The sender is a fixed system no-reply on movo.com.my (passes
 * the domain's DKIM/SPF even though it is not itself a managed mailbox).
 */

import type { Env, SendRequest } from "../types";
import { sendViaCfEmail } from "./cfemail";

/** Fixed system sender for activation notices. */
const WELCOME_FROM = { address: "no-reply@movo.com.my", name: "Movo Mail" } as const;

/** Inputs needed to compose + address a welcome email. */
export interface WelcomeEmailInput {
  /** The new @movo.com.my mailbox address that was just created. */
  address: string;
  /** Optional display name for the mailbox. */
  displayName: string | null;
  /** The owner's personal login (Google) email — the recipient. */
  ownerEmail: string;
  /** Webmail origin the owner signs into (derived from the admin's request). */
  loginUrl: string;
}

/** A rendered email: subject plus both body representations. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Minimal HTML-escape for values interpolated into the HTML body. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Compose the welcome email (pure). English copy that makes the World-B login
 * explicit: sign in with the owner's Google account (the recipient address),
 * never the @movo.com.my mailbox address.
 */
export function buildWelcomeEmail(input: WelcomeEmailInput): RenderedEmail {
  const { address, ownerEmail, loginUrl } = input;
  const subject = `Your Movo Mail inbox ${address} is ready`;

  const text = [
    `Your Movo Mail inbox is ready.`,
    ``,
    `Mailbox: ${address}`,
    ``,
    `How to sign in:`,
    `1. Open ${loginUrl}`,
    `2. Sign in with your Google account: ${ownerEmail}`,
    `3. Your inbox opens automatically — there is no separate password to set.`,
    ``,
    `Important: sign in with the Google account this message was sent to`,
    `(${ownerEmail}), not the ${address} address.`,
    ``,
    `This is an automated message — please do not reply.`,
    ``,
    `— Movo Mail`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f5f6fa;font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a2e;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e6e8f0;">
          <tr><td style="background:#0028AF;padding:20px 28px;">
            <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.01em;">Movo Mail</span>
          </td></tr>
          <tr><td style="padding:28px;">
            <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;">Your inbox is ready</h1>
            <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#444;">
              An inbox has been created for you:
              <strong style="color:#0028AF;">${esc(address)}</strong>
            </p>
            <p style="margin:0 0 8px;font-size:14px;font-weight:600;">How to sign in</p>
            <ol style="margin:0 0 20px;padding-left:20px;font-size:14px;line-height:1.7;color:#444;">
              <li>Open <a href="${esc(loginUrl)}" style="color:#0028AF;">${esc(loginUrl)}</a></li>
              <li>Sign in with your Google account: <strong>${esc(ownerEmail)}</strong></li>
              <li>Your inbox opens automatically — no separate password to set.</li>
            </ol>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
              <tr><td style="border-radius:8px;background:#0028AF;">
                <a href="${esc(loginUrl)}" style="display:inline-block;padding:11px 22px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">Open Movo Mail</a>
              </td></tr>
            </table>
            <p style="margin:0;font-size:12px;line-height:1.6;color:#888;border-top:1px solid #eee;padding-top:16px;">
              Sign in with the Google account this message was sent to
              (<strong>${esc(ownerEmail)}</strong>), not the ${esc(address)} address.
              This is an automated message — please do not reply.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}

/**
 * Build + send the welcome email through the cf-email relay. Throws on relay
 * failure; POST /admin/mailboxes calls this best-effort and never lets a send
 * failure block the (already-committed) mailbox creation.
 */
export async function sendWelcomeEmail(
  env: Env,
  input: WelcomeEmailInput,
): Promise<void> {
  const { subject, html, text } = buildWelcomeEmail(input);
  const req: SendRequest = {
    from: { address: WELCOME_FROM.address, name: WELCOME_FROM.name },
    to: [{ address: input.ownerEmail }],
    subject,
    html,
    text,
  };
  await sendViaCfEmail(env, req);
}
