import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { DB } from "../src/db.js";
import { findByTokenHash, hashTokenSecret, storeHashedToken } from "../src/lib/token-secrets.js";

describe("storeHashedToken", () => {
  let db: DB | undefined;

  afterEach(() => {
    db?.close();
  });

  it("hashes the token at the provided index", () => {
    db = new Database(":memory:");
    db.exec("CREATE TABLE password_reset_tokens (account_id TEXT, token TEXT)");

    storeHashedToken(
      db,
      "INSERT INTO password_reset_tokens (account_id, token) VALUES (?, ?)",
      ["acct-1", "plain-token"],
      1,
    );

    const row = db
      .prepare("SELECT token FROM password_reset_tokens WHERE account_id = ?")
      .get("acct-1") as { token: string } | undefined;

    expect(row?.token).toBe(hashTokenSecret("plain-token"));
  });

  it("throws a descriptive error when tokenIndex is out of range", () => {
    db = new Database(":memory:");
    db.exec("CREATE TABLE password_reset_tokens (account_id TEXT, token TEXT)");

    expect(() => {
      storeHashedToken(
        db!,
        "INSERT INTO password_reset_tokens (account_id, token) VALUES (?, ?)",
        ["acct-1", "plain-token"],
        2,
      );
    }).toThrow("tokenIndex 2 out of range for 2 params");
  });

  it("throws a descriptive error when indexed parameter is not a string", () => {
    db = new Database(":memory:");
    db.exec("CREATE TABLE password_reset_tokens (account_id TEXT, token TEXT)");

    expect(() => {
      storeHashedToken(
        db!,
        "INSERT INTO password_reset_tokens (account_id, token) VALUES (?, ?)",
        ["acct-1", 123],
        1,
      );
    }).toThrow("Token parameter at index 1 must be a string (got number)");
  });
});


describe("token hash lookup guardrails", () => {
  let db: DB | undefined;

  afterEach(() => {
    db?.close();
  });

  it("does not resolve plaintext token rows through hash-only lookup", () => {
    db = new Database(":memory:");
    db.exec("CREATE TABLE calendar_feed_tokens (account_id TEXT, token TEXT)");
    db.prepare("INSERT INTO calendar_feed_tokens (account_id, token) VALUES (?, ?)").run("acct-1", "raw-token");

    const row = findByTokenHash<{ account_id: string }>(
      db,
      "SELECT account_id FROM calendar_feed_tokens WHERE token = ?",
      "raw-token",
    );

    expect(row).toBeUndefined();
  });

  it("stores token-like secrets as 64-char hex hashes", () => {
    db = new Database(":memory:");
    db.exec("CREATE TABLE email_change_requests (account_id TEXT, token TEXT)");

    storeHashedToken(
      db,
      "INSERT INTO email_change_requests (account_id, token) VALUES (?, ?)",
      ["acct-1", "change-token"],
      1,
    );

    const row = db.prepare("SELECT token FROM email_change_requests WHERE account_id = ?").get("acct-1") as { token: string };
    expect(row.token).toMatch(/^[a-f0-9]{64}$/);
    expect(row.token).toBe(hashTokenSecret("change-token"));
  });
});
