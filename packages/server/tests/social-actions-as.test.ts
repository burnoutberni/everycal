import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { userRoutes } from "../src/routes/users.js";
import { eventRoutes } from "../src/routes/events.js";

function makeApp(db: DB, userId = "owner") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", { id: userId, username: userId });
    await next();
  });
  app.route("/api/v1/users", userRoutes(db));
  app.route("/api/v1/events", eventRoutes(db));
  return app;
}

describe("social actions as identity", () => {
  let db: DB;

  beforeEach(() => {
    db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("owner", "owner");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'identity')").run("identity1", "collective");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("target", "target");
    db.prepare(
      "INSERT INTO identity_memberships (identity_account_id, member_account_id, role) VALUES (?, ?, 'editor')"
    ).run("identity1", "owner");
  });

  it("replaces local follow actors with desired chips", async () => {
    db.prepare("INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)").run("owner", "target");

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/users/target/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desiredAccountIds: ["identity1"] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { operationId?: string };
    expect(body.operationId).toBeTruthy();
    const ownerFollow = db
      .prepare("SELECT 1 AS ok FROM follows WHERE follower_id = ? AND following_id = ?")
      .get("owner", "target") as { ok: number } | undefined;
    const identityFollow = db
      .prepare("SELECT 1 AS ok FROM follows WHERE follower_id = ? AND following_id = ?")
      .get("identity1", "target") as { ok: number } | undefined;

    const op = db
      .prepare("SELECT action_kind, status FROM actor_selection_operations WHERE id = ?")
      .get(body.operationId) as { action_kind: string; status: string } | undefined;
    const opItems = db
      .prepare("SELECT COUNT(*) AS count FROM actor_selection_operation_items WHERE operation_id = ?")
      .get(body.operationId) as { count: number };

    expect(ownerFollow).toBeUndefined();
    expect(identityFollow?.ok).toBe(1);
    expect(op?.action_kind).toBe("follow");
    expect(op?.status).toBe("completed");
    expect(opItems.count).toBe(2);
  });

  it("returns 400 for malformed follow actor payload", async () => {
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/users/target/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desiredAccountIds: { nope: true } }),
    });

    expect(res.status).toBe(400);
  });

  it("replaces auto-repost actors with desired chips", async () => {
    db.prepare("INSERT OR IGNORE INTO auto_reposts (account_id, source_account_id) VALUES (?, ?)").run("owner", "target");

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/users/target/auto-repost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desiredAccountIds: ["identity1"] }),
    });

    expect(res.status).toBe(200);
    const ownerAuto = db
      .prepare("SELECT 1 AS ok FROM auto_reposts WHERE account_id = ? AND source_account_id = ?")
      .get("owner", "target") as { ok: number } | undefined;
    const identityAuto = db
      .prepare("SELECT 1 AS ok FROM auto_reposts WHERE account_id = ? AND source_account_id = ?")
      .get("identity1", "target") as { ok: number } | undefined;

    expect(ownerAuto).toBeUndefined();
    expect(identityAuto?.ok).toBe(1);
  });

  it("returns 400 for malformed auto-repost actor payload", async () => {
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/users/target/auto-repost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desiredAccountIds: "owner" }),
    });

    expect(res.status).toBe(400);
  });

  it("replaces repost actors with desired chips", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("ev1", "target", "target", "event-1", "Event 1", "2026-03-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z", "UTC", "public");
    db.prepare("INSERT OR IGNORE INTO reposts (account_id, event_id) VALUES (?, ?)").run("owner", "ev1");

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events/ev1/repost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desiredAccountIds: ["identity1"] }),
    });

    expect(res.status).toBe(200);
    const ownerRepost = db
      .prepare("SELECT 1 AS ok FROM reposts WHERE account_id = ? AND event_id = ?")
      .get("owner", "ev1") as { ok: number } | undefined;
    const identityRepost = db
      .prepare("SELECT 1 AS ok FROM reposts WHERE account_id = ? AND event_id = ?")
      .get("identity1", "ev1") as { ok: number } | undefined;

    expect(ownerRepost).toBeUndefined();
    expect(identityRepost?.ok).toBe(1);
  });

  it("returns 400 for malformed repost actor payload", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("ev1", "target", "target", "event-1", "Event 1", "2026-03-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z", "UTC", "public");

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events/ev1/repost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desiredAccountIds: ["owner", 5] }),
    });

    expect(res.status).toBe(400);
  });

  it("reports partial failure for follow actor updates", async () => {
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/users/collective/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desiredAccountIds: ["owner", "identity1"] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      added: number;
      failed: number;
      results: Array<{ accountId: string; status: string; message?: string }>;
    };
    expect(body.added).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results.find((row) => row.accountId === "owner")?.status).toBe("added");
    expect(body.results.find((row) => row.accountId === "identity1")?.status).toBe("error");
  });

  it("reports partial failure for auto-repost actor updates", async () => {
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/users/collective/auto-repost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desiredAccountIds: ["owner", "identity1"] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      added: number;
      failed: number;
      results: Array<{ accountId: string; status: string; message?: string }>;
    };
    expect(body.added).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results.find((row) => row.accountId === "owner")?.status).toBe("added");
    expect(body.results.find((row) => row.accountId === "identity1")?.status).toBe("error");
  });

  it("reports partial failure for repost actor updates", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("ev-self", "identity1", "owner", "event-self", "Event Self", "2026-03-03T10:00:00.000Z", "2026-03-03T10:00:00.000Z", "UTC", "public");

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events/ev-self/repost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desiredAccountIds: ["owner", "identity1"] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      added: number;
      failed: number;
      results: Array<{ accountId: string; status: string; message?: string }>;
    };
    expect(body.added).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results.find((row) => row.accountId === "owner")?.status).toBe("added");
    expect(body.results.find((row) => row.accountId === "identity1")?.status).toBe("error");
  });
});
