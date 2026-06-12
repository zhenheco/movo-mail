/**
 * Admin data-access (src/db) tests — user roles + mailbox management.
 *
 * Same node:sqlite-backed D1 adapter strategy as test/db.test.ts: the REAL
 * parameterized SQL the implementation emits is exercised against Node's
 * built-in SQLite engine, so column names, constraints and the actual
 * migrations match production. Both `0001_init.sql` AND `0002_user_role.sql`
 * are loaded and applied in order, so the `users.role` column exists exactly
 * as it will in D1.
 *
 * `node:sqlite` is loaded via `createRequire` (not a top-level import) so the
 * vite transform pipeline never tries to resolve the bare `sqlite` specifier.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  getUserByEmail,
  getMailboxByAddress,
  getMailboxesForUser,
  upsertUserByEmail,
  getUserRole,
  listAllMailboxes,
  createMailbox,
  deleteMailbox,
  isManagedAddress,
  MailboxExistsError,
} from "../src/db";
import type { Env } from "../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// node:sqlite (loaded without going through vite's transform)
// ─────────────────────────────────────────────────────────────────────────────

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
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
// Minimal D1 adapter over node:sqlite (test-only). Mirrors test/db.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

function makeD1(db: SqliteDatabase): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    const stmt = db.prepare(sql);
    let bound: unknown[] = [];

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

function loadMigration(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "..", "migrations", name), "utf8");
  // `references` is a reserved word. D1's SQLite build accepts it bare in a
  // column definition, but the stricter `node:sqlite` build requires it quoted.
  // Same replace as test/db.test.ts so the loaded schema is faithful.
  return sql.replace(/^(\s*)references(\s+TEXT\b)/m, '$1"references"$2');
}

function makeEnv(): Env {
  const db = new DatabaseSync(":memory:");
  // Apply migrations IN ORDER: 0001 creates users, 0002 adds users.role,
  // 0003 makes the mailbox address index UNIQUE (case-variant duplicate guard).
  db.exec(loadMigration("0001_init.sql"));
  db.exec(loadMigration("0002_user_role.sql"));
  db.exec(loadMigration("0003_mailboxes_address_unique.sql"));
  db.exec(loadMigration("0004_shared_mailboxes.sql"));
  return { DB: makeD1(db) } as unknown as Env;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("db admin (real SQL via node:sqlite, 0001+0002 applied)", () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv();
  });

  describe("migration 0004 shared mailboxes", () => {
    it("adds mailbox kind and nullable thread assignee columns", async () => {
      const mailboxColumns = await env.DB.prepare(
        `PRAGMA table_info(mailboxes)`,
      ).all<{ name: string; notnull: number; dflt_value: string | null }>();
      const kind = mailboxColumns.results?.find((c) => c.name === "kind");
      expect(kind).toMatchObject({
        notnull: 1,
        dflt_value: "'personal'",
      });

      const threadColumns = await env.DB.prepare(
        `PRAGMA table_info(threads)`,
      ).all<{ name: string; notnull: number }>();
      const assignee = threadColumns.results?.find(
        (c) => c.name === "assignee_id",
      );
      expect(assignee).toMatchObject({ notnull: 0 });

      const threadFks = await env.DB.prepare(
        `PRAGMA foreign_key_list(threads)`,
      ).all<{ from: string; table: string; to: string; on_delete: string }>();
      expect(threadFks.results).toContainEqual(
        expect.objectContaining({
          from: "assignee_id",
          table: "users",
          to: "id",
          on_delete: "SET NULL",
        }),
      );
    });
  });

  describe("upsertUserByEmail / getUserByEmail / getUserRole", () => {
    it("creates a new user with role 'user' and returns its id", async () => {
      const id = await upsertUserByEmail(env, "alice@movo.com.my", "Alice");
      expect(id).toMatch(UUID_RE);

      const user = await getUserByEmail(env, "alice@movo.com.my");
      expect(user).not.toBeNull();
      expect(user?.id).toBe(id);
      expect(user?.email).toBe("alice@movo.com.my");
      expect(user?.name).toBe("Alice");
      expect(user?.role).toBe("user");
    });

    it("accepts a null name", async () => {
      const id = await upsertUserByEmail(env, "noname@movo.com.my", null);
      const user = await getUserByEmail(env, "noname@movo.com.my");
      expect(user?.id).toBe(id);
      expect(user?.name).toBeNull();
      expect(user?.role).toBe("user");
    });

    it("returns the existing id (idempotent) when the user already exists", async () => {
      const first = await upsertUserByEmail(env, "bob@movo.com.my", "Bob");
      const second = await upsertUserByEmail(env, "bob@movo.com.my", "Bob 2");
      expect(second).toBe(first);
    });

    it("does NOT downgrade an existing admin to 'user' on re-upsert", async () => {
      const id = await upsertUserByEmail(env, "boss@movo.com.my", "Boss");
      // Promote to admin out-of-band (simulating a manual grant).
      await env.DB.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`)
        .bind(id)
        .run();
      expect(await getUserRole(env, "boss@movo.com.my")).toBe("admin");

      // Re-upsert (e.g. on next login) must keep admin, not reset to 'user'.
      const again = await upsertUserByEmail(env, "boss@movo.com.my", "Boss");
      expect(again).toBe(id);
      expect(await getUserRole(env, "boss@movo.com.my")).toBe("admin");
    });

    it("getUserByEmail returns null for an unknown user", async () => {
      expect(await getUserByEmail(env, "ghost@movo.com.my")).toBeNull();
    });

    it("getUserRole returns null for an unknown user", async () => {
      expect(await getUserRole(env, "ghost@movo.com.my")).toBeNull();
    });

    it("getUserRole returns 'user' for a freshly upserted user", async () => {
      await upsertUserByEmail(env, "carol@movo.com.my", null);
      expect(await getUserRole(env, "carol@movo.com.my")).toBe("user");
    });

    it("getUserByEmail is injection-safe (literal match)", async () => {
      await upsertUserByEmail(env, "real@movo.com.my", null);
      expect(await getUserByEmail(env, "x' OR '1'='1")).toBeNull();
    });

    it("matches stored users by normalized email casing for ownership and roles", async () => {
      await createMailbox(env, {
        address: "support@movo.com.my",
        ownerEmail: "Owner@Gmail.Com",
        displayName: "Support",
      });

      const mailboxes = await getMailboxesForUser(env, "owner@gmail.com");
      expect(mailboxes.map((m) => m.address)).toEqual(["support@movo.com.my"]);

      const adminId = await upsertUserByEmail(env, "Admin@Gmail.Com", null);
      await env.DB.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`)
        .bind(adminId)
        .run();
      expect(await getUserRole(env, "admin@gmail.com")).toBe("admin");
    });
  });

  describe("createMailbox / listAllMailboxes", () => {
    it("creates a mailbox with an owner and returns a uuid id", async () => {
      const { id } = await createMailbox(env, {
        address: "support@movo.com.my",
        ownerEmail: "alice@movo.com.my",
        displayName: "Support",
      });
      expect(id).toMatch(UUID_RE);

      const all = await listAllMailboxes(env);
      expect(all).toHaveLength(1);
      expect(all[0]?.id).toBe(id);
      expect(all[0]?.address).toBe("support@movo.com.my");
      expect(all[0]?.displayName).toBe("Support");
      expect(all[0]?.ownerEmail).toBe("alice@movo.com.my");
    });

    it("upserts the owner user (creating it if missing) on createMailbox", async () => {
      await createMailbox(env, {
        address: "sales@movo.com.my",
        ownerEmail: "newowner@movo.com.my",
        displayName: null,
      });
      // The owner must now exist as a 'user'.
      expect(await getUserRole(env, "newowner@movo.com.my")).toBe("user");
    });

    it("reuses an existing owner user without downgrading admin role", async () => {
      const id = await upsertUserByEmail(env, "adminowner@movo.com.my", null);
      await env.DB.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`)
        .bind(id)
        .run();
      await createMailbox(env, {
        address: "ops@movo.com.my",
        ownerEmail: "adminowner@movo.com.my",
        displayName: null,
      });
      expect(await getUserRole(env, "adminowner@movo.com.my")).toBe("admin");
    });

    it("allows a null ownerEmail (unowned mailbox)", async () => {
      const { id } = await createMailbox(env, {
        address: "noreply@movo.com.my",
        ownerEmail: null,
        displayName: "No Reply",
        kind: "personal",
      });
      const all = await listAllMailboxes(env);
      const row = all.find((m) => m.id === id);
      expect(row?.ownerEmail).toBeNull();
      expect(row?.displayName).toBe("No Reply");
    });

    it("stores and reads mailbox kind for personal and shared mailboxes", async () => {
      const ownerId = await upsertUserByEmail(env, "owner@movo.com.my", null);
      const personal = await createMailbox(env, {
        address: "personal@movo.com.my",
        ownerEmail: "owner@movo.com.my",
        displayName: "Personal",
        kind: "personal",
      });
      const shared = await createMailbox(env, {
        address: "shared@movo.com.my",
        ownerEmail: null,
        displayName: "Shared",
        kind: "shared",
      });

      const personalRow = await getMailboxesForUser(env, "owner@movo.com.my");
      expect(personalRow).toHaveLength(1);
      expect(personalRow[0]).toMatchObject({
        id: personal.id,
        kind: "personal",
        owner_id: ownerId,
      });

      const sharedRow = await env.DB.prepare(
        `SELECT kind, owner_id FROM mailboxes WHERE id = ?`,
      )
        .bind(shared.id)
        .first<{ kind: string; owner_id: string | null }>();
      expect(sharedRow).toEqual({ kind: "shared", owner_id: null });

      const sharedByAddress = await getMailboxByAddress(
        env,
        "shared@movo.com.my",
      );
      expect(sharedByAddress).toMatchObject({ id: shared.id, kind: "shared" });

      const all = await listAllMailboxes(env);
      expect(all.find((m) => m.id === shared.id)).toMatchObject({
        ownerEmail: null,
        kind: "shared",
      });
    });

    it("throws MailboxExistsError when the address already exists", async () => {
      await createMailbox(env, {
        address: "dup@movo.com.my",
        ownerEmail: null,
        displayName: null,
        kind: "personal",
      });
      await expect(
        createMailbox(env, {
          address: "dup@movo.com.my",
          ownerEmail: null,
          displayName: null,
          kind: "personal",
        }),
      ).rejects.toBeInstanceOf(MailboxExistsError);
    });

    it("stores the address normalized (lowercased) so lookups are case-insensitive", async () => {
      await createMailbox(env, {
        address: "Sales@Movo.Com.My",
        ownerEmail: null,
        displayName: null,
      });
      const all = await listAllMailboxes(env);
      expect(all).toHaveLength(1);
      // Stored in canonical lowercase form…
      expect(all[0]?.address).toBe("sales@movo.com.my");
    });

    it("rejects a case-variant of an existing address (no duplicate-row hijack)", async () => {
      await createMailbox(env, {
        address: "sales@movo.com.my",
        ownerEmail: "owner1@movo.com.my",
        displayName: null,
      });
      // A different-cased duplicate, even with a DIFFERENT owner, must collide.
      await expect(
        createMailbox(env, {
          address: "Sales@movo.com.my",
          ownerEmail: "attacker@movo.com.my",
          displayName: null,
        }),
      ).rejects.toBeInstanceOf(MailboxExistsError);
      // Only the original row exists.
      const all = await listAllMailboxes(env);
      expect(all).toHaveLength(1);
      expect(all[0]?.ownerEmail).toBe("owner1@movo.com.my");
    });

    it("orders listAllMailboxes by address ASC", async () => {
      await createMailbox(env, {
        address: "zeta@movo.com.my",
        ownerEmail: null,
        displayName: null,
      });
      await createMailbox(env, {
        address: "alpha@movo.com.my",
        ownerEmail: null,
        displayName: null,
      });
      await createMailbox(env, {
        address: "mid@movo.com.my",
        ownerEmail: null,
        displayName: null,
      });
      const all = await listAllMailboxes(env);
      expect(all.map((m) => m.address)).toEqual([
        "alpha@movo.com.my",
        "mid@movo.com.my",
        "zeta@movo.com.my",
      ]);
    });

    it("LEFT JOINs users so a mailbox with a missing owner still lists (null ownerEmail)", async () => {
      const ownerId = await upsertUserByEmail(env, "temp@movo.com.my", null);
      const { id } = await createMailbox(env, {
        address: "joined@movo.com.my",
        ownerEmail: "temp@movo.com.my",
        displayName: null,
      });
      // Delete the owner directly; FK is ON DELETE SET NULL on mailboxes.owner_id.
      await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(ownerId).run();
      const all = await listAllMailboxes(env);
      const row = all.find((m) => m.id === id);
      expect(row).toBeDefined();
      expect(row?.ownerEmail).toBeNull();
    });

    it("returns [] when there are no mailboxes", async () => {
      expect(await listAllMailboxes(env)).toHaveLength(0);
    });
  });

  describe("deleteMailbox", () => {
    it("deletes an existing mailbox and returns true", async () => {
      const { id } = await createMailbox(env, {
        address: "gone@movo.com.my",
        ownerEmail: null,
        displayName: null,
      });
      expect(await deleteMailbox(env, id)).toBe(true);
      expect(await listAllMailboxes(env)).toHaveLength(0);
    });

    it("returns false when the mailbox id is not found", async () => {
      expect(await deleteMailbox(env, "does-not-exist")).toBe(false);
    });

    it("cascades: deleting a mailbox removes its threads and messages", async () => {
      const { id } = await createMailbox(env, {
        address: "cascade@movo.com.my",
        ownerEmail: null,
        displayName: null,
      });
      const now = Date.now();
      // Seed a thread + message under the mailbox (FK ON DELETE CASCADE chain).
      await env.DB.prepare(
        `INSERT INTO threads
           (id, mailbox_id, subject, snippet, last_message_at, message_count,
            unread, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      )
        .bind("t-1", id, "Hi", "snip", now, now, now)
        .run();
      await env.DB.prepare(
        `INSERT INTO messages
           (id, thread_id, mailbox_id, message_id, direction, from_address,
            to_addresses, has_attachments, unread, date, created_at)
         VALUES (?, ?, ?, ?, 'inbound', ?, ?, 0, 1, ?, ?)`,
      )
        .bind(
          "m-1",
          "t-1",
          id,
          "<m-1@x>",
          "a@x.com",
          JSON.stringify(["cascade@movo.com.my"]),
          now,
          now,
        )
        .run();

      expect(await deleteMailbox(env, id)).toBe(true);

      const threadLeft = await env.DB.prepare(
        `SELECT id FROM threads WHERE id = ?`,
      )
        .bind("t-1")
        .first();
      const msgLeft = await env.DB.prepare(
        `SELECT id FROM messages WHERE id = ?`,
      )
        .bind("m-1")
        .first();
      expect(threadLeft).toBeNull();
      expect(msgLeft).toBeNull();
    });
  });

  describe("isManagedAddress", () => {
    it("returns true for a managed (existing) mailbox address", async () => {
      await createMailbox(env, {
        address: "managed@movo.com.my",
        ownerEmail: null,
        displayName: null,
      });
      expect(await isManagedAddress(env, "managed@movo.com.my")).toBe(true);
    });

    it("returns false for an unmanaged address", async () => {
      expect(await isManagedAddress(env, "stranger@movo.com.my")).toBe(false);
    });

    it("matches case-insensitively (inbound casing differs from stored)", async () => {
      await createMailbox(env, {
        address: "managed@movo.com.my",
        ownerEmail: null,
        displayName: null,
      });
      // Inbound mail arrives with the sender's original casing — must still match.
      expect(await isManagedAddress(env, "Managed@Movo.Com.My")).toBe(true);
    });

    it("is injection-safe (literal match, no match-all)", async () => {
      await createMailbox(env, {
        address: "x@movo.com.my",
        ownerEmail: null,
        displayName: null,
      });
      expect(await isManagedAddress(env, "x' OR '1'='1")).toBe(false);
    });
  });
});
