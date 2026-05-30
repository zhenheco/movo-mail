/**
 * Data-access (src/db) tests.
 *
 * These run under the default (Node) vitest pool. To exercise the REAL
 * parameterized SQL the implementation emits — and to prove it is injection
 * safe — we back a tiny D1-compatible adapter with Node's built-in SQLite
 * engine (`node:sqlite`, stable in Node 22+/24+). The adapter mirrors the
 * subset of the D1 API the implementation uses: `prepare().bind().all()/
 * .first()/.run()`. The actual `0001_init.sql` migration is loaded and applied,
 * so column names, indexes and constraints (e.g. the UNIQUE idempotency key)
 * match production.
 *
 * `node:sqlite` is loaded via `createRequire` (not a top-level `import`) so the
 * vite transform pipeline never tries to resolve the bare `sqlite` specifier.
 *
 * Why not @cloudflare/vitest-pool-workers here? That pool needs TEST_MIGRATIONS
 * wired into the workers vitest config and a built web/dist — out of this
 * module's touch scope. node:sqlite gives the same real-SQL guarantees with
 * zero new deps and zero config changes.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  getThreads,
  getThread,
  getMessage,
  searchMessages,
  insertInboundMessage,
  insertOutboundMessage,
  upsertThread,
  insertSendLog,
  updateSendLogStatus,
  getSendLog,
  insertAudit,
  getAuditLog,
  getMailboxByAddress,
  getMailboxesForUser,
  type OutboundMessageInput,
} from "../src/db";
import type { Env, ParsedInbound, EmailAddress } from "../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// node:sqlite (loaded without going through vite's transform)
// ─────────────────────────────────────────────────────────────────────────────

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as SqliteModule;

// ─────────────────────────────────────────────────────────────────────────────
// Minimal D1 adapter over node:sqlite (test-only).
// ─────────────────────────────────────────────────────────────────────────────

function makeD1(db: SqliteDatabase): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    const stmt = db.prepare(sql);
    let bound: unknown[] = [];

    // Only the surface the implementation actually uses. The object is cast to
    // D1PreparedStatement through `unknown` so the full (e.g. overloaded `raw`)
    // signature isn't required — those paths are never hit in src/db.
    const api = {
      bind(...values: unknown[]) {
        bound = values.map((v) => (v === undefined ? null : v));
        return api as unknown as D1PreparedStatement;
      },
      async all<T = unknown>(): Promise<D1Result<T>> {
        const results = stmt.all(...bound) as T[];
        return { results, success: true, meta: {} } as unknown as D1Result<T>;
      },
      async first<T = unknown>(): Promise<T | null> {
        const row = stmt.get(...bound) as T | undefined;
        return row ?? null;
      },
      async run<T = unknown>(): Promise<D1Result<T>> {
        const info = stmt.run(...bound);
        return {
          results: [],
          success: true,
          meta: {
            changes: Number(info.changes),
            last_row_id: Number(info.lastInsertRowid),
          },
        } as unknown as D1Result<T>;
      },
    };
    return api as unknown as D1PreparedStatement;
  };

  return {
    prepare,
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}

function migrationSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(
    join(here, "..", "migrations", "0001_init.sql"),
    "utf8",
  );
  // `references` is a reserved word. D1's SQLite build accepts it bare in a
  // column definition, but the stricter `node:sqlite` build requires it quoted.
  // Quote only the DDL declaration; every runtime query already uses the quoted
  // identifier, so this keeps the test faithful to the real schema.
  return sql.replace(
    /^(\s*)references(\s+TEXT\b)/m,
    '$1"references"$2',
  );
}

function makeEnv(): Env {
  const db = new DatabaseSync(":memory:");
  db.exec(migrationSql());
  return { DB: makeD1(db) } as unknown as Env;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const addr = (address: string, name?: string): EmailAddress =>
  name ? { address, name } : { address };

async function seedMailbox(
  env: Env,
  id: string,
  address: string,
  ownerId: string | null = null,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO mailboxes (id, address, display_name, owner_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, address, null, ownerId, now, now)
    .run();
}

async function seedUser(
  env: Env,
  id: string,
  email: string,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, email, null, now, now)
    .run();
}

function makeInbound(overrides: Partial<ParsedInbound> = {}): ParsedInbound {
  const base: ParsedInbound = {
    mailboxAddress: "support@movo.com.my",
    messageId: "<msg-1@example.com>",
    inReplyTo: null,
    references: [],
    from: addr("alice@example.com", "Alice"),
    to: [addr("support@movo.com.my")],
    cc: [],
    bcc: [],
    subject: "Order question",
    text: "Where is my order?",
    html: "<p>Where is my order?</p>",
    snippet: "Where is my order?",
    date: 1_700_000_000_000,
    attachments: [],
    raw: new TextEncoder().encode("raw-eml-bytes").buffer,
  };
  return { ...base, ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("db (real SQL via node:sqlite)", () => {
  let env: Env;

  beforeEach(async () => {
    env = makeEnv();
    await seedMailbox(env, "mb-1", "support@movo.com.my");
  });

  describe("getMailboxByAddress", () => {
    it("resolves a seeded mailbox by address", async () => {
      const mb = await getMailboxByAddress(env, "support@movo.com.my");
      expect(mb).not.toBeNull();
      expect(mb?.id).toBe("mb-1");
      expect(mb?.address).toBe("support@movo.com.my");
    });

    it("returns null for an unknown address", async () => {
      expect(await getMailboxByAddress(env, "nope@movo.com.my")).toBeNull();
    });

    it("treats a quote-injection string as a literal (no match)", async () => {
      const mb = await getMailboxByAddress(env, "x' OR '1'='1");
      expect(mb).toBeNull();
    });
  });

  describe("getMailboxesForUser", () => {
    it("returns only the mailboxes owned by the user", async () => {
      await seedUser(env, "u-alice", "alice@movo.com.my");
      await seedUser(env, "u-bob", "bob@movo.com.my");
      await seedMailbox(env, "mb-alice-1", "alice@movo.com.my", "u-alice");
      await seedMailbox(env, "mb-alice-2", "team@movo.com.my", "u-alice");
      await seedMailbox(env, "mb-bob", "bob@movo.com.my", "u-bob");

      const mailboxes = await getMailboxesForUser(env, "alice@movo.com.my");
      expect(mailboxes).toHaveLength(2);
      expect(mailboxes.map((m) => m.id).sort()).toEqual([
        "mb-alice-1",
        "mb-alice-2",
      ]);
    });

    it("returns [] for a user that owns no mailboxes", async () => {
      await seedUser(env, "u-carol", "carol@movo.com.my");
      expect(await getMailboxesForUser(env, "carol@movo.com.my")).toHaveLength(
        0,
      );
    });

    it("returns [] for an unknown user (injection-safe)", async () => {
      expect(
        await getMailboxesForUser(env, "ghost' OR '1'='1"),
      ).toHaveLength(0);
    });
  });

  describe("insertInboundMessage + getThreads", () => {
    it("creates a thread and a message, marked unread", async () => {
      const id = await insertInboundMessage(env, makeInbound());
      expect(id).toMatch(UUID_RE);

      const threads = await getThreads(env, "mb-1");
      expect(threads).toHaveLength(1);
      expect(threads[0]?.subject).toBe("Order question");
      expect(threads[0]?.message_count).toBe(1);
      expect(threads[0]?.unread).toBe(1);
      expect(threads[0]?.snippet).toBe("Where is my order?");
    });

    it("rejects an unknown mailbox address", async () => {
      await expect(
        insertInboundMessage(
          env,
          makeInbound({ mailboxAddress: "ghost@movo.com.my" }),
        ),
      ).rejects.toThrow(/mailbox/i);
    });

    it("groups a reply into the same thread via In-Reply-To", async () => {
      await insertInboundMessage(env, makeInbound());
      await insertInboundMessage(
        env,
        makeInbound({
          messageId: "<msg-2@example.com>",
          inReplyTo: "<msg-1@example.com>",
          references: ["<msg-1@example.com>"],
          subject: "Re: Order question",
          text: "Following up",
          snippet: "Following up",
          date: 1_700_000_100_000,
        }),
      );

      const threads = await getThreads(env, "mb-1");
      expect(threads).toHaveLength(1);
      expect(threads[0]?.message_count).toBe(2);
      expect(threads[0]?.last_message_at).toBe(1_700_000_100_000);
      expect(threads[0]?.snippet).toBe("Following up");
    });

    it("starts a new thread when no reply headers match", async () => {
      await insertInboundMessage(env, makeInbound());
      await insertInboundMessage(
        env,
        makeInbound({
          messageId: "<msg-unrelated@example.com>",
          subject: "Different topic",
          date: 1_700_000_200_000,
        }),
      );
      expect(await getThreads(env, "mb-1")).toHaveLength(2);
    });

    it("orders threads by newest activity first", async () => {
      await insertInboundMessage(
        env,
        makeInbound({ date: 1_700_000_000_000, subject: "Old" }),
      );
      await insertInboundMessage(
        env,
        makeInbound({
          messageId: "<msg-new@example.com>",
          subject: "New",
          date: 1_700_000_500_000,
        }),
      );
      const threads = await getThreads(env, "mb-1");
      expect(threads).toHaveLength(2);
      expect(threads[0]?.subject).toBe("New");
      expect(threads[1]?.subject).toBe("Old");
    });

    it("persists attachments and flags has_attachments", async () => {
      const id = await insertInboundMessage(
        env,
        makeInbound({
          attachments: [
            {
              filename: "invoice.pdf",
              contentType: "application/pdf",
              contentId: null,
              inline: false,
              content: new TextEncoder().encode("pdf-bytes"),
            },
          ],
        }),
      );
      const msg = await getMessage(env, id);
      expect(msg?.has_attachments).toBe(1);
      expect(msg?.attachments).toHaveLength(1);
      expect(msg?.attachments[0]?.filename).toBe("invoice.pdf");
      expect(msg?.attachments[0]?.content_type).toBe("application/pdf");
      expect(msg?.attachments[0]?.size_bytes).toBe(9);
    });

    it("scopes threads to the requested mailbox", async () => {
      await seedMailbox(env, "mb-2", "sales@movo.com.my");
      await insertInboundMessage(env, makeInbound());
      await insertInboundMessage(
        env,
        makeInbound({
          mailboxAddress: "sales@movo.com.my",
          messageId: "<msg-sales@example.com>",
          subject: "Sales lead",
        }),
      );
      expect(await getThreads(env, "mb-1")).toHaveLength(1);
      const mb2 = await getThreads(env, "mb-2");
      expect(mb2).toHaveLength(1);
      expect(mb2[0]?.subject).toBe("Sales lead");
    });
  });

  describe("getThread / getMessage", () => {
    it("loads a thread with its messages oldest→newest", async () => {
      const firstId = await insertInboundMessage(env, makeInbound());
      await insertInboundMessage(
        env,
        makeInbound({
          messageId: "<msg-2@example.com>",
          inReplyTo: "<msg-1@example.com>",
          references: ["<msg-1@example.com>"],
          text: "later",
          date: 1_700_000_200_000,
        }),
      );

      const threadId = (await getThreads(env, "mb-1"))[0]!.id;
      const thread = await getThread(env, threadId);
      expect(thread).not.toBeNull();
      expect(thread?.messages).toHaveLength(2);
      expect(thread?.messages[0]?.id).toBe(firstId);
      expect(thread!.messages[0]!.date).toBeLessThan(thread!.messages[1]!.date);
    });

    it("returns null for a missing thread", async () => {
      expect(await getThread(env, "does-not-exist")).toBeNull();
    });

    it("returns null for a missing message", async () => {
      expect(await getMessage(env, "does-not-exist")).toBeNull();
    });

    it("stores to_addresses as a JSON array string", async () => {
      const id = await insertInboundMessage(
        env,
        makeInbound({
          to: [addr("support@movo.com.my"), addr("ops@movo.com.my")],
        }),
      );
      const msg = await getMessage(env, id);
      expect(msg?.to_addresses).toBe(
        JSON.stringify(["support@movo.com.my", "ops@movo.com.my"]),
      );
    });
  });

  describe("searchMessages", () => {
    beforeEach(async () => {
      await insertInboundMessage(
        env,
        makeInbound({
          subject: "Refund request",
          text: "Please refund my purchase",
          snippet: "Please refund my purchase",
        }),
      );
      await insertInboundMessage(
        env,
        makeInbound({
          messageId: "<msg-other@example.com>",
          subject: "Shipping update",
          text: "Your package is on the way",
          snippet: "Your package is on the way",
          date: 1_700_000_300_000,
        }),
      );
    });

    it("matches on subject", async () => {
      const results = await searchMessages(env, "Refund");
      expect(results).toHaveLength(1);
      expect(results[0]?.subject).toBe("Refund request");
    });

    it("matches on body text", async () => {
      const results = await searchMessages(env, "package");
      expect(results).toHaveLength(1);
      expect(results[0]?.subject).toBe("Shipping update");
    });

    it("matches on from_address", async () => {
      const results = await searchMessages(env, "alice@example.com");
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it("scopes by mailbox when provided", async () => {
      await seedMailbox(env, "mb-2", "sales@movo.com.my");
      await insertInboundMessage(
        env,
        makeInbound({
          mailboxAddress: "sales@movo.com.my",
          messageId: "<msg-sales@example.com>",
          subject: "Refund elsewhere",
          text: "refund please",
          snippet: "refund please",
        }),
      );
      const scoped = await searchMessages(env, "refund", "mb-2");
      expect(scoped).toHaveLength(1);
      expect(scoped[0]?.subject).toBe("Refund elsewhere");
    });

    it("escapes LIKE wildcards so '%' is matched literally (not match-all)", async () => {
      expect(await searchMessages(env, "%")).toHaveLength(0);
    });

    it("treats an injection string as a literal", async () => {
      expect(await searchMessages(env, "' OR 1=1 --")).toHaveLength(0);
    });

    it("returns empty for no matches", async () => {
      expect(await searchMessages(env, "zzz-nope")).toHaveLength(0);
    });
  });

  describe("upsertThread", () => {
    it("creates a new thread when no id given", async () => {
      const tid = await upsertThread(env, {
        mailboxId: "mb-1",
        subject: "Hi",
        snippet: "Hello there",
        lastMessageAt: 1_700_000_000_000,
        unread: true,
      });
      expect(tid).toMatch(UUID_RE);
      const thread = await getThread(env, tid);
      expect(thread?.subject).toBe("Hi");
      expect(thread?.unread).toBe(1);
      expect(thread?.message_count).toBe(1);
    });

    it("updates an existing thread's activity and OR-s in unread", async () => {
      const tid = await upsertThread(env, {
        mailboxId: "mb-1",
        subject: "Hi",
        snippet: "first",
        lastMessageAt: 1_700_000_000_000,
        unread: false,
      });
      const same = await upsertThread(env, {
        mailboxId: "mb-1",
        threadId: tid,
        subject: "Hi",
        snippet: "second",
        lastMessageAt: 1_700_000_900_000,
        unread: true,
      });
      expect(same).toBe(tid);
      const thread = await getThread(env, tid);
      expect(thread?.snippet).toBe("second");
      expect(thread?.last_message_at).toBe(1_700_000_900_000);
      expect(thread?.unread).toBe(1);
      expect(thread?.message_count).toBe(2);
    });

    it("inserts a fresh row if the given threadId is stale", async () => {
      const tid = await upsertThread(env, {
        mailboxId: "mb-1",
        threadId: "11111111-1111-1111-1111-111111111111",
        subject: "Recover",
        snippet: "s",
        lastMessageAt: 1_700_000_000_000,
        unread: false,
      });
      expect(tid).toBe("11111111-1111-1111-1111-111111111111");
      expect(await getThread(env, tid)).not.toBeNull();
    });
  });

  describe("insertOutboundMessage", () => {
    it("stores an outbound copy under an existing thread (read, not unread)", async () => {
      const tid = await upsertThread(env, {
        mailboxId: "mb-1",
        subject: "Re: hi",
        snippet: "reply",
        lastMessageAt: 1_700_000_000_000,
        unread: false,
      });
      const input: OutboundMessageInput = {
        threadId: tid,
        mailboxId: "mb-1",
        messageId: "<out-1@movo.com.my>",
        inReplyTo: "<msg-1@example.com>",
        references: "<msg-1@example.com>",
        fromAddress: "support@movo.com.my",
        fromName: "Support",
        toAddresses: ["alice@example.com"],
        ccAddresses: [],
        bccAddresses: [],
        subject: "Re: hi",
        text: "Thanks for reaching out",
        html: "<p>Thanks for reaching out</p>",
        snippet: "Thanks for reaching out",
        hasAttachments: false,
        date: 1_700_000_950_000,
      };
      const mid = await insertOutboundMessage(env, input);
      const msg = await getMessage(env, mid);
      expect(msg?.direction).toBe("outbound");
      expect(msg?.from_address).toBe("support@movo.com.my");
      expect(msg?.unread).toBe(0);
      expect(msg?.to_addresses).toBe(JSON.stringify(["alice@example.com"]));
      expect(msg?.r2_raw_key).toBe(`msg/${mid}.eml`);
    });

    it("creates a real parent thread for a brand-new (non-reply) send so it is visible", async () => {
      // Regression: a non-reply send used to point at a phantom thread id,
      // violating the messages→threads FK so the copy was never persisted.
      // Omitting threadId must now mint a real thread the message is visible in.
      const input: OutboundMessageInput = {
        // threadId omitted → brand-new conversation.
        mailboxId: "mb-1",
        messageId: "<out-new@movo.com.my>",
        inReplyTo: null,
        references: null,
        fromAddress: "support@movo.com.my",
        fromName: "Support",
        toAddresses: ["alice@example.com"],
        ccAddresses: [],
        bccAddresses: [],
        subject: "Brand new",
        text: "Hello from scratch",
        html: null,
        snippet: "Hello from scratch",
        hasAttachments: false,
        date: 1_700_000_960_000,
      };
      const mid = await insertOutboundMessage(env, input);

      // A thread now exists in the mailbox and contains the outbound message.
      const threads = await getThreads(env, "mb-1");
      expect(threads).toHaveLength(1);
      const loaded = await getThread(env, threads[0]!.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.messages).toHaveLength(1);
      expect(loaded?.messages[0]?.id).toBe(mid);
      expect(loaded?.messages[0]?.direction).toBe("outbound");
    });
  });

  describe("insertInboundMessage key derivation", () => {
    it("uses the supplied id for the message PK + r2_raw_key + attachment r2_key", async () => {
      // Regression: the inbound handler archived R2 objects under one id while
      // the DB minted its own, orphaning the bytes. The caller-supplied id must
      // now flow into the PK and every R2 key so the row points at real objects.
      const id = "11111111-2222-3333-4444-555555555555";
      const returned = await insertInboundMessage(
        env,
        makeInbound({
          attachments: [
            {
              filename: "a.txt",
              contentType: "text/plain",
              contentId: null,
              inline: false,
              content: new TextEncoder().encode("bytes"),
            },
          ],
        }),
        id,
      );
      expect(returned).toBe(id);

      const msg = await getMessage(env, id);
      expect(msg).not.toBeNull();
      expect(msg?.r2_raw_key).toBe(`msg/${id}.eml`);
      expect(msg?.attachments).toHaveLength(1);
      expect(msg?.attachments[0]?.r2_key).toBe(`att/${id}/0`);
    });

    it("defaults to a fresh uuid when no id is supplied", async () => {
      const returned = await insertInboundMessage(env, makeInbound());
      expect(returned).toMatch(UUID_RE);
    });
  });

  describe("send_log", () => {
    it("inserts then reads a send-log row", async () => {
      const id = await insertSendLog(env, {
        messageId: null,
        idempotencyKey: "idem-123",
        providerId: "prov-abc",
        status: "queued",
        toAddresses: ["alice@example.com"],
        subject: "Hello",
        error: null,
      });
      expect(id).toMatch(UUID_RE);
      const row = await getSendLog(env, id);
      expect(row?.idempotency_key).toBe("idem-123");
      expect(row?.status).toBe("queued");
      expect(row?.to_addresses).toBe(JSON.stringify(["alice@example.com"]));
    });

    it("updates status / provider id (COALESCE keeps prior provider)", async () => {
      const id = await insertSendLog(env, {
        messageId: null,
        idempotencyKey: "idem-456",
        providerId: "prov-initial",
        status: "queued",
        toAddresses: ["bob@example.com"],
        subject: "Hi",
        error: null,
      });
      await updateSendLogStatus(env, id, "sent", null, null);
      const row = await getSendLog(env, id);
      expect(row?.status).toBe("sent");
      expect(row?.provider_id).toBe("prov-initial");
    });

    it("records an error and failed status", async () => {
      const id = await insertSendLog(env, {
        messageId: null,
        idempotencyKey: "idem-789",
        providerId: null,
        status: "queued",
        toAddresses: ["c@example.com"],
        subject: "x",
        error: null,
      });
      await updateSendLogStatus(env, id, "failed", null, "relay 500");
      const row = await getSendLog(env, id);
      expect(row?.status).toBe("failed");
      expect(row?.error).toBe("relay 500");
    });

    it("rejects a duplicate idempotency key (UNIQUE constraint)", async () => {
      await insertSendLog(env, {
        messageId: null,
        idempotencyKey: "dup-key",
        providerId: null,
        status: "queued",
        toAddresses: ["a@example.com"],
        subject: "x",
        error: null,
      });
      await expect(
        insertSendLog(env, {
          messageId: null,
          idempotencyKey: "dup-key",
          providerId: null,
          status: "queued",
          toAddresses: ["b@example.com"],
          subject: "y",
          error: null,
        }),
      ).rejects.toThrow();
    });

    it("returns null for a missing send-log id", async () => {
      expect(await getSendLog(env, "nope")).toBeNull();
    });
  });

  describe("audit_log", () => {
    it("inserts an audit row with JSON detail and reads it back", async () => {
      const id = await insertAudit(env, {
        userId: null,
        actorEmail: "admin@movo.com.my",
        action: "send",
        targetType: "message",
        targetId: "m-1",
        detail: { to: ["a@x.com"], subject: "Hi" },
        ip: "1.2.3.4",
      });
      expect(id).toMatch(UUID_RE);
      const rows = await getAuditLog(env, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe("send");
      expect(rows[0]?.actor_email).toBe("admin@movo.com.my");
      expect(rows[0]?.detail).toBe(
        JSON.stringify({ to: ["a@x.com"], subject: "Hi" }),
      );
    });

    it("stores null detail when none given", async () => {
      const id = await insertAudit(env, {
        userId: null,
        actorEmail: "a@movo.com.my",
        action: "read",
        targetType: null,
        targetId: null,
        detail: null,
        ip: null,
      });
      const rows = await getAuditLog(env);
      expect(rows.find((r) => r.id === id)?.detail).toBeNull();
    });

    it("returns rows newest-first and honours the limit", async () => {
      await insertAudit(env, {
        userId: null,
        actorEmail: "a@movo.com.my",
        action: "read",
        targetType: null,
        targetId: null,
        detail: null,
        ip: null,
      });
      await insertAudit(env, {
        userId: null,
        actorEmail: "b@movo.com.my",
        action: "delete",
        targetType: null,
        targetId: null,
        detail: null,
        ip: null,
      });
      const rows = await getAuditLog(env, 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe("delete");
    });
  });
});
