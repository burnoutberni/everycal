import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { userRoutes } from "../src/routes/users.js";
import { eventRoutes } from "../src/routes/events.js";

const originalBaseUrl = process.env.BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined) {
    delete process.env.BASE_URL;
  } else {
    process.env.BASE_URL = originalBaseUrl;
  }
});

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
    db.prepare("INSERT OR IGNORE INTO auto_reposts (account_id, source_account_id, source_actor_uri) VALUES (?, ?, ?)").run("owner", "target", "https://localhost/users/target");

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

  it("rejects ambiguous remote handles for auto-repost", async () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://evil.host/users/alice", "alice", "https://evil.host/inbox", "evil@host");

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/users/alice@evil@host/auto-repost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
  });

  it("rejects ambiguous remote handles for remote user routes", async () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://evil.host/users/alice", "alice", "https://evil.host/inbox", "evil@host");

    const app = makeApp(db);
    const paths = [
      "/api/v1/users/alice@evil@host",
      "/api/v1/users/alice@evil@host/events",
      "/api/v1/users/alice@evil@host/followers",
      "/api/v1/users/alice@evil@host/following",
    ];

    for (const path of paths) {
      const res = await app.request(`http://localhost${path}`);
      expect(res.status).toBe(404);
    }
  });

  it("accepts remote handles with explicit federation ports", async () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example:8443/users/alice", "alice", "https://remote.example:8443/inbox", "remote.example:8443");

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/users/alice@remote.example:8443");

    expect(res.status).toBe(200);
    const body = await res.json() as { username?: string; source?: string };
    expect(body.username).toBe("alice@remote.example:8443");
    expect(body.source).toBe("remote");
  });

  it("replaces repost actors with desired chips", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("ev1", "target", "target", "event-1", "Event 1", "2026-03-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z", "UTC", "public");
    db.prepare("INSERT OR IGNORE INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)").run(
      "owner",
      "ev1",
      "http://localhost:3000/events/ev1",
      "https://localhost/users/target",
    );

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

  it("stores canonical local event_uri when creating repost", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("ev-canonical", "target", "target", "event-canonical", "Event Canonical", "2026-03-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z", "UTC", "public");

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events/ev-canonical/repost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const row = db.prepare("SELECT event_uri FROM reposts WHERE account_id = ? AND event_id = ?")
      .get("owner", "ev-canonical") as { event_uri: string };
    expect(row.event_uri).toBe("http://localhost:3000/events/ev-canonical");
  });

  it("accepts canonical local event URI as repost id", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("ev-canonical-uri", "target", "target", "event-canonical-uri", "Event Canonical URI", "2026-03-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z", "UTC", "public");

    const app = makeApp(db);
    const canonicalId = encodeURIComponent("http://localhost:3000/events/ev-canonical-uri");
    const res = await app.request(`http://localhost/api/v1/events/${canonicalId}/repost`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const row = db.prepare("SELECT event_id, event_uri FROM reposts WHERE account_id = ?").get("owner") as { event_id: string; event_uri: string };
    expect(row.event_id).toBe("ev-canonical-uri");
    expect(row.event_uri).toBe("http://localhost:3000/events/ev-canonical-uri");
  });

  it("accepts canonical local event URI with base-path prefix as repost id", async () => {
    process.env.BASE_URL = "http://localhost:3000/app";
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("ev-base-path-uri", "target", "target", "event-base-path-uri", "Event Base Path URI", "2026-03-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z", "UTC", "public");

    const app = makeApp(db);
    const canonicalId = encodeURIComponent("http://localhost:3000/app/events/ev-base-path-uri");
    const res = await app.request(`http://localhost/api/v1/events/${canonicalId}/repost`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const row = db.prepare("SELECT event_id, event_uri FROM reposts WHERE account_id = ?").get("owner") as { event_id: string; event_uri: string };
    expect(row.event_id).toBe("ev-base-path-uri");
    expect(row.event_uri).toBe("http://localhost:3000/app/events/ev-base-path-uri");
  });

  it("deletes repost for canonical local event_uri", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("ev-legacy", "target", "target", "event-legacy", "Event Legacy", "2026-03-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z", "UTC", "public");
    db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)").run(
      "owner",
      "ev-legacy",
      "http://localhost:3000/events/ev-legacy",
      "https://localhost/users/target",
    );

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events/ev-legacy/repost", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { removed: boolean };
    const remaining = db.prepare("SELECT 1 AS ok FROM reposts WHERE account_id = ? AND event_uri = ?")
      .get("owner", "http://localhost:3000/events/ev-legacy") as { ok: number } | undefined;
    expect(body.removed).toBe(true);
    expect(remaining).toBeUndefined();
  });

  it("deletes repost when id is canonical local event URI", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("ev-delete-canonical", "target", "target", "event-delete-canonical", "Event Delete Canonical", "2026-03-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z", "UTC", "public");
    db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)").run(
      "owner",
      "ev-delete-canonical",
      "http://localhost:3000/events/ev-delete-canonical",
      "https://localhost/users/target",
    );

    const app = makeApp(db);
    const canonicalId = encodeURIComponent("http://localhost:3000/events/ev-delete-canonical");
    const res = await app.request(`http://localhost/api/v1/events/${canonicalId}/repost`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { removed: boolean };
    expect(body.removed).toBe(true);
    const remaining = db.prepare("SELECT 1 AS ok FROM reposts WHERE account_id = ? AND event_uri = ?")
      .get("owner", "http://localhost:3000/events/ev-delete-canonical") as { ok: number } | undefined;
    expect(remaining).toBeUndefined();
  });

  it("removes repost rows via desiredAccountIds", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("ev-mixed", "target", "target", "event-mixed", "Event Mixed", "2026-03-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z", "UTC", "public");
    db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)").run(
      "owner",
      "ev-mixed",
      "http://localhost:3000/events/ev-mixed",
      "https://localhost/users/target",
    );

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events/ev-mixed/repost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desiredAccountIds: [] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { removed: number };
    const remaining = db.prepare("SELECT 1 AS ok FROM reposts WHERE account_id = ? AND event_uri = ?")
      .get("owner", "http://localhost:3000/events/ev-mixed") as { ok: number } | undefined;
    expect(body.removed).toBe(1);
    expect(remaining).toBeUndefined();
  });

  it("includes canonical local repost rows in repost-actors", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("ev-repost-actors", "target", "target", "event-repost-actors", "Event Repost Actors", "2026-03-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z", "UTC", "public");
    db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)").run(
      "owner",
      "ev-repost-actors",
      "http://localhost:3000/events/ev-repost-actors",
      "https://localhost/users/target",
    );
    db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)").run("identity1", "ev-repost-actors", "http://localhost:3000/events/ev-repost-actors", "https://localhost/users/target");

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events/ev-repost-actors/repost-actors", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { activeAccountIds: string[]; actorIds: string[] };
    expect(body.activeAccountIds).toEqual(expect.arrayContaining(["owner", "identity1"]));
    expect(body.activeAccountIds).toHaveLength(2);
    expect(body.actorIds).toEqual(expect.arrayContaining(["owner", "identity1"]));
  });

  it("includes repost actors when id is canonical local event URI", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("ev-actors-canonical", "target", "target", "event-actors-canonical", "Event Actors Canonical", "2026-03-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z", "UTC", "public");
    db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)").run(
      "owner",
      "ev-actors-canonical",
      "http://localhost:3000/events/ev-actors-canonical",
      "https://localhost/users/target",
    );

    const app = makeApp(db);
    const canonicalId = encodeURIComponent("http://localhost:3000/events/ev-actors-canonical");
    const res = await app.request(`http://localhost/api/v1/events/${canonicalId}/repost-actors`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { activeAccountIds: string[] };
    expect(body.activeAccountIds).toContain("owner");
  });

  it("dedupes auto-repost when explicit repost exists with URL-form event_uri", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("ev-dedupe", "target", "target", "event-dedupe", "Event Dedupe", "2026-03-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z", "UTC", "public");
    db.prepare("INSERT INTO auto_reposts (account_id, source_account_id, source_actor_uri) VALUES (?, ?, ?)").run(
      "owner",
      "target",
      "https://localhost/users/target",
    );
    db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)").run(
      "owner",
      "ev-dedupe",
      "http://localhost:3000/events/ev-dedupe",
      "https://localhost/users/target",
    );

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/users/owner/events?includeReposts=true", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { events: Array<{ id: string }> };
    expect(body.events.filter((event) => event.id === "ev-dedupe")).toHaveLength(1);
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
