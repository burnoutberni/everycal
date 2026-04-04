import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { authRoutes } from "../src/routes/auth.js";

function makeApp(db: DB, userId = "owner") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", { id: userId, username: userId, displayName: userId });
    await next();
  });
  app.route("/api/v1/auth", authRoutes(db));
  return app;
}

describe("account deletion", () => {
  let db: DB;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  it("blocks deletion when user is the last owner of an identity", async () => {
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("owner", "owner");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'identity')").run("identity1", "collective");

    db.prepare(
      "INSERT INTO identity_memberships (identity_account_id, member_account_id, role) VALUES (?, ?, 'owner')"
    ).run("identity1", "owner");

    const app = makeApp(db, "owner");
    const res = await app.request("http://localhost/api/v1/auth/me", { method: "DELETE" });

    expect(res.status).toBe(409);
    const body = await res.json() as { code?: string; identities?: string[] };
    expect(body.code).toBe("last_identity_owner");
    expect(body.identities).toEqual(["collective"]);

    const ownerAccount = db.prepare("SELECT id FROM accounts WHERE id = ?").get("owner") as { id: string } | undefined;
    expect(ownerAccount?.id).toBe("owner");
  });

  it("preserves identity-owned events when another owner remains", async () => {
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("owner", "owner");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("coowner", "coowner");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'identity')").run("identity1", "collective");

    db.prepare(
      "INSERT INTO identity_memberships (identity_account_id, member_account_id, role) VALUES (?, ?, 'owner')"
    ).run("identity1", "owner");
    db.prepare(
      "INSERT INTO identity_memberships (identity_account_id, member_account_id, role) VALUES (?, ?, 'owner')"
    ).run("identity1", "coowner");

    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("ev_identity", "identity1", "owner", "identity-event", "Identity Event", "2026-03-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z", "UTC", "public");

    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("ev_personal", "owner", "owner", "personal-event", "Personal Event", "2026-03-02T10:00:00.000Z", "2026-03-02T10:00:00.000Z", "UTC", "public");

    const app = makeApp(db, "owner");
    const res = await app.request("http://localhost/api/v1/auth/me", { method: "DELETE" });

    expect(res.status).toBe(200);

    const ownerAccount = db.prepare("SELECT id FROM accounts WHERE id = ?").get("owner") as { id: string } | undefined;
    expect(ownerAccount).toBeUndefined();

    const identityAccount = db.prepare("SELECT id FROM accounts WHERE id = ?").get("identity1") as { id: string } | undefined;
    expect(identityAccount?.id).toBe("identity1");

    const owners = db
      .prepare("SELECT member_account_id FROM identity_memberships WHERE identity_account_id = ? AND role = 'owner' ORDER BY member_account_id ASC")
      .all("identity1") as Array<{ member_account_id: string }>;
    expect(owners.map((row) => row.member_account_id)).toEqual(["coowner"]);

    const identityOwnedEvent = db
      .prepare("SELECT account_id, created_by_account_id FROM events WHERE id = ?")
      .get("ev_identity") as { account_id: string; created_by_account_id: string | null } | undefined;
    expect(identityOwnedEvent?.account_id).toBe("identity1");
    expect(identityOwnedEvent?.created_by_account_id).toBeNull();

    const personalEvent = db
      .prepare("SELECT id FROM events WHERE id = ?")
      .get("ev_personal") as { id: string } | undefined;
    expect(personalEvent).toBeUndefined();
  });
});
