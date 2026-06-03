/**
 * One-off backfill: send the welcome/activation email to owners of mailboxes
 * that were created BEFORE the auto-welcome feature (commit f59bb68) shipped.
 *
 * Reuses the real buildWelcomeEmail() so the content is byte-identical to what
 * the live worker now sends on new mailbox creation. Posts through the same
 * cf-email relay the worker uses; the API key comes from the environment
 * (CF_EMAIL_API_KEY, injected from 1Password by the caller — never hardcoded).
 *
 * Recipients are passed as RECIPIENTS env (JSON array of {address, ownerEmail,
 * displayName?}). A fixed idempotencyKey per address makes re-runs safe (the
 * relay dedupes), so this can be retried without double-sending.
 *
 *   RECIPIENTS='[...]' CF_EMAIL_API_KEY=… npx tsx scripts/backfill-welcome.mjs
 */
import { buildWelcomeEmail } from "../src/lib/welcome.ts";

const KEY = process.env.CF_EMAIL_API_KEY;
const ENDPOINT = process.env.CF_EMAIL_ENDPOINT || "https://cf-email.acejou27.workers.dev";
const LOGIN_URL = process.env.LOGIN_URL || "https://movo-mail-production.acejou27.workers.dev";
const FROM = "no-reply@movo.com.my";

if (!KEY) {
  console.error("CF_EMAIL_API_KEY missing in env — aborting (no send).");
  process.exit(2);
}

const recipients = JSON.parse(process.env.RECIPIENTS || "[]");
if (recipients.length === 0) {
  console.error("RECIPIENTS empty — nothing to send.");
  process.exit(2);
}

for (const r of recipients) {
  const { subject, html, text } = buildWelcomeEmail({
    address: r.address,
    displayName: r.displayName ?? null,
    ownerEmail: r.ownerEmail,
    loginUrl: LOGIN_URL,
  });
  const body = {
    to: r.ownerEmail,
    from: FROM,
    subject,
    html,
    text,
    idempotencyKey: `welcome-backfill-${r.address}`,
  };
  let httpStatus = 0;
  let relay = null;
  try {
    const res = await fetch(`${ENDPOINT}/send`, {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    httpStatus = res.status;
    try {
      relay = await res.json();
    } catch {
      relay = null;
    }
  } catch (err) {
    relay = { error: String(err && err.message ? err.message : err) };
  }
  // Never log the key — only routing + relay outcome.
  console.log(
    JSON.stringify({ address: r.address, to: r.ownerEmail, http: httpStatus, relay }),
  );
}
