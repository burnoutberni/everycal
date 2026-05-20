import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDatabase } from "../src/db.js";
import { MIGRATIONS } from "../src/db/migrations.js";

describe("database BASE_URL preflight", () => {
  const previousBaseUrl = process.env.BASE_URL;
  const previousNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.BASE_URL = previousBaseUrl;
    process.env.NODE_ENV = previousNodeEnv;
  });

  it("fails with a clear preflight error before running pending migrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "requires-v10.sqlite");
    const versioned = new Database(dbPath);
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 9)) {
      migration.up(versioned);
    }
    versioned.pragma("user_version = 9");
    versioned.close();

    delete process.env.BASE_URL;
    process.env.NODE_ENV = "production";

    expect(() => initDatabase(dbPath)).toThrow(/BASE_URL preflight check failed before database migrations/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("does not require BASE_URL when no migration crossing v10 is pending", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "already-current.sqlite");

    process.env.NODE_ENV = "test";
    delete process.env.BASE_URL;
    const initialized = initDatabase(dbPath);
    initialized.close();

    process.env.NODE_ENV = "production";
    delete process.env.BASE_URL;
    expect(() => initDatabase(dbPath)).not.toThrow();

    rmSync(dir, { recursive: true, force: true });
  });
});
