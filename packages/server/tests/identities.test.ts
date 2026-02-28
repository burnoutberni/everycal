import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { identityRoutes } from "../src/routes/identities.js";

function makeApp(db: DB, userId = "owner") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", { id: userId, username: userId });
    await next();
  });
  app.route("/api/v1/identities", identityRoutes(db));
  return app;
}

describe("identity deletion", () => {
  let db: DB;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  it("deletes all events owned by identity and preserves unrelated events", async () => {
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("owner", "owner");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'identity')").run("identity1", "collective");

    db.prepare(
      "INSERT INTO identity_memberships (identity_account_id, member_account_id, role) VALUES (?, ?, 'owner')"
    ).run("identity1", "owner");

    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("ev_identity", "identity1", "owner", "identity-event", "Identity Event", "2026-03-01T10:00:00.000Z", "public");

    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("ev_other", "owner", "identity1", "other-event", "Other Event", "2026-03-02T10:00:00.000Z", "public");

    db.prepare(
      "INSERT INTO remote_follows (account_id, follower_actor_uri, follower_inbox) VALUES (?, ?, ?)"
    ).run("identity1", "https://remote.example/users/alice", "https://remote.example/inbox");

    const app = makeApp(db, "owner");
    const res = await app.request("http://localhost/api/v1/identities/collective", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);

    const identityCount = db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE id = ?").get("identity1") as { count: number };
    expect(identityCount.count).toBe(0);

    const ownedEventCount = db.prepare("SELECT COUNT(*) AS count FROM events WHERE account_id = ?").get("identity1") as { count: number };
    expect(ownedEventCount.count).toBe(0);

    const unrelatedEvent = db
      .prepare("SELECT id, created_by_account_id FROM events WHERE id = ?")
      .get("ev_other") as { id: string; created_by_account_id: string | null } | undefined;
    expect(unrelatedEvent?.id).toBe("ev_other");
    expect(unrelatedEvent?.created_by_account_id).toBeNull();

    const remoteFollowsCount = db
      .prepare("SELECT COUNT(*) AS count FROM remote_follows WHERE account_id = ?")
      .get("identity1") as { count: number };
    expect(remoteFollowsCount.count).toBe(0);
  });
});
