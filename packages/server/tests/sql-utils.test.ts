import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { containsPattern, escapeLike, likeClause } from "../src/lib/sql-utils.js";

describe("sql-utils", () => {
  describe("escapeLike", () => {
    it("escapes backslash, percent and underscore", () => {
      expect(escapeLike("100%")).toBe("100\\%");
      expect(escapeLike("a_b")).toBe("a\\_b");
      expect(escapeLike("a\\b")).toBe("a\\\\b");
    });

    it("leaves benign input unchanged", () => {
      expect(escapeLike("hello world")).toBe("hello world");
      expect(escapeLike("")).toBe("");
    });

    it("escapes backslashes before percent and underscore", () => {
      expect(escapeLike("\\%_")).toBe("\\\\\\%\\_");
    });
  });

  describe("containsPattern", () => {
    it("wraps the escaped value in substring wildcards", () => {
      expect(containsPattern("100%")).toBe("%100\\%%");
      expect(containsPattern("a_b")).toBe("%a\\_b%");
    });

    it("preserves the wildcards around an empty string", () => {
      expect(containsPattern("")).toBe("%%");
    });
  });

  describe("likeClause", () => {
    it("emits a LIKE fragment with the SQLite ESCAPE clause", () => {
      expect(likeClause("events.title")).toBe("events.title LIKE ? ESCAPE '\\'");
    });
  });

  describe("end-to-end search behavior", () => {
    function makeDb() {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE rows (label TEXT NOT NULL)");
      const seed = ["100%", "a_b", "plain", "100", "a b", "weird\\path", "200% off", "a_b_c"];
      const insert = db.prepare("INSERT INTO rows (label) VALUES (?)");
      for (const label of seed) insert.run(label);
      return db;
    }

    function search(db: Database.Database, term: string) {
      return db
        .prepare(`SELECT label FROM rows WHERE ${likeClause("label")} ORDER BY label`)
        .all(containsPattern(term)) as Array<{ label: string }>;
    }

    it("matches a row containing a literal percent", () => {
      expect(search(makeDb(), "100%").map((r) => r.label)).toEqual(["100%"]);
    });

    it("matches a row containing a literal underscore", () => {
      expect(search(makeDb(), "a_b").map((r) => r.label)).toEqual(["a_b", "a_b_c"]);
    });

    it("matches a row containing a literal backslash", () => {
      expect(search(makeDb(), "weird\\path").map((r) => r.label)).toEqual(["weird\\path"]);
    });

    it("does not treat percent as a wildcard when the user typed a literal", () => {
      const db = makeDb();
      const matches = search(db, "1%").map((r) => r.label);
      expect(matches).toEqual([]);
    });

    it("does not treat underscore as a wildcard when the user typed a literal", () => {
      const db = makeDb();
      const matches = search(db, "a_b").map((r) => r.label);
      expect(matches).toEqual(["a_b", "a_b_c"]);
      expect(matches).not.toContain("a b");
    });

    it("still performs substring matching for benign queries", () => {
      expect(search(makeDb(), "100").map((r) => r.label)).toEqual(["100", "100%"]);
    });
  });
});
