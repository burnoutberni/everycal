import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { initDatabase, type DB } from "../src/db.js";
import {
  normalizeFederationBlockDomain,
  hasActiveFederationBlock,
} from "../src/lib/federation-blocks.js";
import { MIGRATIONS } from "../src/db/migrations.js";
import { generateKeyPair } from "../src/lib/crypto.js";

function insertAccount(db: DB, id = "acct1", username = "alice") {
  const keys = generateKeyPair();
  db.prepare("INSERT INTO accounts (id, username, private_key, public_key) VALUES (?, ?, ?, ?)").run(id, username, keys.privateKey, keys.publicKey);
}

function insertRemoteActor(db: DB, domain: string, uri = `https://${domain}/users/bob`) {
  db.prepare("INSERT INTO remote_actors (uri, type, preferred_username, inbox, outbox, domain) VALUES (?, 'Person', 'bob', ?, ?, ?)")
    .run(uri, `https://${domain}/inbox`, `https://${domain}/users/bob/outbox`, domain);
}

describe("normalizeFederationBlockDomain", () => {
  it("returns null for null/undefined/empty", () => {
    expect(normalizeFederationBlockDomain(null)).toBeNull();
    expect(normalizeFederationBlockDomain(undefined)).toBeNull();
    expect(normalizeFederationBlockDomain("")).toBeNull();
    expect(normalizeFederationBlockDomain("   ")).toBeNull();
  });

  it("lowercases bare hostname", () => {
    expect(normalizeFederationBlockDomain("Bad.Example.COM")).toBe("bad.example.com");
  });

  it("strips trailing slash from bare hostname", () => {
    expect(normalizeFederationBlockDomain("bad.example.com/")).toBe("bad.example.com");
  });

  it("extracts hostname from https URL", () => {
    expect(normalizeFederationBlockDomain("https://bad.example.com")).toBe("bad.example.com");
  });

  it("extracts hostname from https URL with trailing slash", () => {
    expect(normalizeFederationBlockDomain("https://bad.example.com/")).toBe("bad.example.com");
  });

  it("extracts hostname from https URL with path", () => {
    expect(normalizeFederationBlockDomain("https://bad.example.com/some/path")).toBe("bad.example.com");
  });

  it("extracts hostname from http URL", () => {
    expect(normalizeFederationBlockDomain("http://bad.example.com")).toBe("bad.example.com");
  });

  it("trims whitespace around URL", () => {
    expect(normalizeFederationBlockDomain("  https://bad.example.com  ")).toBe("bad.example.com");
  });

  it("returns null for invalid input", () => {
    expect(normalizeFederationBlockDomain("not a domain at all")).toBeNull();
  });
});

describe("federation block domain enforcement", () => {
  it("blocks actor from matching domain when domain block uses hostname", () => {
    const db = initDatabase(":memory:");
    insertAccount(db);
    insertRemoteActor(db, "bad.example.com");

    db.prepare("INSERT INTO federation_blocks (id, block_type, domain, reason, created_by_account_id, is_active) VALUES (?, 'domain', ?, 'test', ?, 1)")
      .run("block-1", "bad.example.com", "acct1");

    expect(hasActiveFederationBlock(db, { actorUri: "https://bad.example.com/users/bob" })).toBe(true);
  });

  it("blocks actor when admin entered full URL", () => {
    const db = initDatabase(":memory:");
    insertAccount(db);
    insertRemoteActor(db, "bad.example.com");

    const domain = normalizeFederationBlockDomain("https://bad.example.com");
    db.prepare("INSERT INTO federation_blocks (id, block_type, domain, reason, created_by_account_id, is_active) VALUES (?, 'domain', ?, 'test', ?, 1)")
      .run("block-1", domain, "acct1");

    expect(hasActiveFederationBlock(db, { actorUri: "https://bad.example.com/users/bob" })).toBe(true);
  });

  it("blocks actor when admin entered URL with trailing slash", () => {
    const db = initDatabase(":memory:");
    insertAccount(db);
    insertRemoteActor(db, "bad.example.com");

    const domain = normalizeFederationBlockDomain("bad.example.com/");
    db.prepare("INSERT INTO federation_blocks (id, block_type, domain, reason, created_by_account_id, is_active) VALUES (?, 'domain', ?, 'test', ?, 1)")
      .run("block-1", domain, "acct1");

    expect(hasActiveFederationBlock(db, { actorUri: "https://bad.example.com/users/bob" })).toBe(true);
  });

  it("does not block unrelated domains", () => {
    const db = initDatabase(":memory:");
    insertAccount(db);
    insertRemoteActor(db, "good.example.com");

    const domain = normalizeFederationBlockDomain("https://bad.example.com");
    db.prepare("INSERT INTO federation_blocks (id, block_type, domain, reason, created_by_account_id, is_active) VALUES (?, 'domain', ?, 'test', ?, 1)")
      .run("block-1", domain, "acct1");

    expect(hasActiveFederationBlock(db, { actorUri: "https://good.example.com/users/bob" })).toBe(false);
  });
});

describe("migration federation_blocks_normalize_domain", () => {
  function applyMigrationsThrough(db: DB, maxVersion: number): void {
    for (const migration of MIGRATIONS) {
      if (migration.version > maxVersion) break;
      migration.up(db);
    }
  }

  it("normalizes existing inert domain blocks to bare hostnames", () => {
    const db = new Database(":memory:");
    applyMigrationsThrough(db, 13);
    insertAccount(db);

    db.prepare("INSERT INTO federation_blocks (id, block_type, domain, reason, created_by_account_id, is_active) VALUES (?, 'domain', ?, 'test', ?, 1)")
      .run("pre-url", "https://bad.example.com", "acct1");
    db.prepare("INSERT INTO federation_blocks (id, block_type, domain, reason, created_by_account_id, is_active) VALUES (?, 'domain', ?, 'test', ?, 1)")
      .run("pre-trailing", "good.example.com/", "acct1");
    db.prepare("INSERT INTO federation_blocks (id, block_type, domain, reason, created_by_account_id, is_active) VALUES (?, 'domain', ?, 'test', ?, 1)")
      .run("pre-ok", "already.fine.example", "acct1");

    const migration = MIGRATIONS.find((entry) => entry.version === 14);
    if (!migration) throw new Error("migration 14 not found");
    migration.up(db);

    const rows = db.prepare("SELECT id, domain FROM federation_blocks ORDER BY id").all() as Array<{ id: string; domain: string }>;
    expect(rows).toEqual([
      { id: "pre-ok", domain: "already.fine.example" },
      { id: "pre-trailing", domain: "good.example.com" },
      { id: "pre-url", domain: "bad.example.com" },
    ]);
  });
});
