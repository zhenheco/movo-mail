/// <reference types="@cloudflare/vitest-pool-workers" />

import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { AccessEnv } from "../../src/middleware/access";
import type { AccessUser, Env } from "../../src/types";
import type { MessageWithAttachments } from "../../src/db";
import { messageRoutes } from "../../src/api/message";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const USER: AccessUser = { sub: "user-1", email: "owner@example.com" };

const RESET_SQL: readonly string[] = [
  "DROP TABLE IF EXISTS attachments",
  "DROP TABLE IF EXISTS messages",
  "DROP TABLE IF EXISTS threads",
  "DROP TABLE IF EXISTS mailboxes",
  "DROP TABLE IF EXISTS users",
  `CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE mailboxes (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL UNIQUE,
    display_name TEXT,
    owner_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL,
    subject TEXT,
    snippet TEXT,
    last_message_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    unread INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    mailbox_id TEXT NOT NULL,
    message_id TEXT,
    in_reply_to TEXT,
    "references" TEXT,
    direction TEXT NOT NULL,
    from_address TEXT NOT NULL,
    from_name TEXT,
    to_addresses TEXT NOT NULL,
    cc_addresses TEXT,
    bcc_addresses TEXT,
    subject TEXT,
    snippet TEXT,
    text_body TEXT,
    html_body TEXT,
    r2_raw_key TEXT,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    unread INTEGER NOT NULL DEFAULT 1,
    date INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    content_id TEXT,
    inline INTEGER NOT NULL DEFAULT 0,
    r2_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

function app(): Hono<AccessEnv> {
  const h = new Hono<AccessEnv>();
  h.use("*", async (c, next) => {
    c.set("user", USER);
    await next();
  });
  h.route("/", messageRoutes());
  return h;
}

async function resetDb(): Promise<void> {
  for (const sql of RESET_SQL) {
    await env.DB.prepare(sql).run();
  }
}

async function seedBase(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind("user-1", USER.email, null, now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO mailboxes (id, address, display_name, owner_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind("mb-1", "support@movo.com.my", "Support", "user-1", now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO threads
       (id, mailbox_id, subject, snippet, last_message_at, message_count, unread, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind("th-1", "mb-1", "Hi", "hello", now, 1, 1, now, now)
    .run();
}

async function seedMessage(
  id: string,
  htmlBody: string | null,
  r2RawKey: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages
       (id, thread_id, mailbox_id, message_id, in_reply_to, "references",
        direction, from_address, from_name, to_addresses, cc_addresses,
        bcc_addresses, subject, snippet, text_body, html_body, r2_raw_key,
        has_attachments, unread, date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
  )
    .bind(
      id,
      "th-1",
      "mb-1",
      `<${id}@example.com>`,
      null,
      null,
      "sender@example.com",
      "Sender",
      JSON.stringify(["support@movo.com.my"]),
      null,
      null,
      "Hi",
      "hello",
      "plain fallback",
      htmlBody,
      r2RawKey,
      Date.now(),
      Date.now(),
    )
    .run();
}

async function openMessage(id: string): Promise<Response> {
  return app().request(`/message/${id}`, undefined, env);
}

describe("GET /message/:id in workerd", () => {
  beforeEach(async () => {
    await resetDb();
    await seedBase();
  });

  it("returns 200 with null html_body instead of reading raw .eml as HTML", async () => {
    const rawKey = "msg/text-only.eml";
    await env.MAIL_R2.put(
      rawKey,
      [
        "From: Sender <sender@example.com>",
        "To: support@movo.com.my",
        "Subject: Hi",
        "",
        "plain fallback",
      ].join("\r\n"),
    );
    await seedMessage("msg-text-only", null, rawKey);

    const res = await openMessage("msg-text-only");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: MessageWithAttachments };
    expect(body.message.html_body).toBeNull();
    expect(body.message.text_body).toBe("plain fallback");
  });

  it("returns persisted html_body unchanged", async () => {
    const rawHtml = '<p onclick="evil()">Hi</p><script>x()</script>';
    await seedMessage("msg-html", rawHtml);

    const res = await openMessage("msg-html");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: MessageWithAttachments };
    expect(body.message.html_body).toBe(rawHtml);
  });
});
