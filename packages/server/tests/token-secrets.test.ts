import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { DB } from "../src/db.js";
import { hashTokenSecret, storeHashedToken } from "../src/lib/token-secrets.js";

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
