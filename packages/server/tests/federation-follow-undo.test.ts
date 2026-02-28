import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";

vi.mock("../src/lib/federation.js", () => ({
  fetchAP: vi.fn(),
  resolveRemoteActor: vi.fn(),
  fetchRemoteOutbox: vi.fn(),
  deliverActivity: vi.fn(),
  discoverDomainActors: vi.fn(),
}));

import { federationRoutes } from "../src/routes/federation-api.js";
import { resolveRemoteActor, deliverActivity } from "../src/lib/federation.js";

function makeApp(db: DB, userId = "owner", username = "owner") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", { id: userId, username, displayName: username });
    await next();
  });
  app.route("/api/v1/federation", federationRoutes(db));
  return app;
}

describe("federation follow/unfollow Undo references", () => {
  let db: DB;

  beforeEach(() => {
    db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("owner", "owner");
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: "https://remote.example/users/alice",
      type: "Person",
      preferred_username: "alice",
      display_name: "Alice",
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: null,
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.mocked(deliverActivity).mockResolvedValue(true);
  });

  it("stores follow activity id for remote follow", async () => {
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/federation/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: "https://remote.example/users/alice" }),
    });

    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT follow_activity_id, follow_object_uri FROM remote_following WHERE account_id = ? AND actor_uri = ?")
      .get("owner", "https://remote.example/users/alice") as { follow_activity_id: string | null; follow_object_uri: string | null } | undefined;
    expect(row?.follow_activity_id).toContain("#follows/");
    expect(row?.follow_object_uri).toBe(row?.follow_activity_id);
  });

  it("generates a new follow activity id on repeated follow", async () => {
    const app = makeApp(db);

    const first = await app.request("http://localhost/api/v1/federation/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: "https://remote.example/users/alice" }),
    });
    expect(first.status).toBe(200);
    const firstRow = db
      .prepare("SELECT follow_activity_id FROM remote_following WHERE account_id = ? AND actor_uri = ?")
      .get("owner", "https://remote.example/users/alice") as { follow_activity_id: string | null } | undefined;

    const second = await app.request("http://localhost/api/v1/federation/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: "https://remote.example/users/alice" }),
    });
    expect(second.status).toBe(200);
    const secondRow = db
      .prepare("SELECT follow_activity_id FROM remote_following WHERE account_id = ? AND actor_uri = ?")
      .get("owner", "https://remote.example/users/alice") as { follow_activity_id: string | null } | undefined;

    expect(firstRow?.follow_activity_id).toContain("#follows/");
    expect(secondRow?.follow_activity_id).toContain("#follows/");
    expect(secondRow?.follow_activity_id).not.toBe(firstRow?.follow_activity_id);
  });

  it("rejects malformed desiredAccountIds payload", async () => {
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/federation/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: "https://remote.example/users/alice", desiredAccountIds: { bad: true } }),
    });

    expect(res.status).toBe(400);
  });

  it("uses stored follow activity id as Undo object", async () => {
    db.prepare("UPDATE accounts SET private_key = ? WHERE id = ?").run("private-key", "owner");
    db.prepare(
      "INSERT INTO remote_following (account_id, actor_uri, actor_inbox, follow_activity_id, follow_object_uri) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "owner",
      "https://remote.example/users/alice",
      "https://remote.example/inbox",
      "https://local.example/users/owner#follows/abc123",
      "https://local.example/users/owner#follows/abc123"
    );

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/federation/unfollow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: "https://remote.example/users/alice" }),
    });

    expect(res.status).toBe(200);
    const lastCall = vi.mocked(deliverActivity).mock.calls.at(-1);
    expect(lastCall).toBeTruthy();
    const activity = lastCall?.[1] as Record<string, unknown>;
    expect(activity.type).toBe("Undo");
    expect(activity.object).toBe("https://local.example/users/owner#follows/abc123");

    const row = db
      .prepare("SELECT 1 AS ok FROM remote_following WHERE account_id = ? AND actor_uri = ?")
      .get("owner", "https://remote.example/users/alice") as { ok: number } | undefined;
    expect(row).toBeUndefined();
  });

  it("falls back to embedded Follow object for legacy rows", async () => {
    db.prepare("UPDATE accounts SET private_key = ? WHERE id = ?").run("private-key", "owner");
    db.prepare(
      "INSERT INTO remote_following (account_id, actor_uri, actor_inbox) VALUES (?, ?, ?)"
    ).run("owner", "https://remote.example/users/alice", "https://remote.example/inbox");

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/federation/unfollow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: "https://remote.example/users/alice" }),
    });

    expect(res.status).toBe(200);
    const lastCall = vi.mocked(deliverActivity).mock.calls.at(-1);
    const activity = lastCall?.[1] as Record<string, unknown>;
    const obj = activity.object as Record<string, unknown>;
    expect(obj.type).toBe("Follow");
    expect(obj.object).toBe("https://remote.example/users/alice");
  });

  it("removes local follow even when Undo delivery fails", async () => {
    db.prepare("UPDATE accounts SET private_key = ? WHERE id = ?").run("private-key", "owner");
    db.prepare(
      "INSERT INTO remote_following (account_id, actor_uri, actor_inbox, follow_activity_id, follow_object_uri) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "owner",
      "https://remote.example/users/alice",
      "https://remote.example/inbox",
      "https://local.example/users/owner#follows/def456",
      "https://local.example/users/owner#follows/def456"
    );
    vi.mocked(deliverActivity).mockResolvedValueOnce(false);

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/federation/unfollow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: "https://remote.example/users/alice" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; delivered: boolean };
    expect(body.ok).toBe(true);
    expect(body.delivered).toBe(false);

    const row = db
      .prepare("SELECT 1 AS ok FROM remote_following WHERE account_id = ? AND actor_uri = ?")
      .get("owner", "https://remote.example/users/alice") as { ok: number } | undefined;
    expect(row).toBeUndefined();
  });

  it("supports multi-actor follow with partial delivery failures", async () => {
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'identity')").run("identity1", "collective");
    db.prepare(
      "INSERT INTO identity_memberships (identity_account_id, member_account_id, role) VALUES (?, ?, 'editor')"
    ).run("identity1", "owner");

    vi.mocked(deliverActivity).mockImplementation(async (_inbox, activity) => {
      const actor = (activity as Record<string, unknown>).actor;
      return typeof actor === "string" ? actor.endsWith("/users/owner") : false;
    });

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/federation/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: "https://remote.example/users/alice", desiredAccountIds: ["owner", "identity1"] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      operationId?: string;
      added: number;
      failed: number;
      results: Array<{ accountId: string; status: string; remoteStatus?: string }>;
    };
    expect(body.operationId).toBeTruthy();
    expect(body.added).toBe(1);
    expect(body.failed).toBe(1);

    const ownerResult = body.results.find((row) => row.accountId === "owner");
    const identityResult = body.results.find((row) => row.accountId === "identity1");
    expect(ownerResult?.status).toBe("added");
    expect(ownerResult?.remoteStatus).toBe("delivered");
    expect(identityResult?.status).toBe("error");
    expect(identityResult?.remoteStatus).toBe("failed");

    const ownerFollow = db
      .prepare("SELECT 1 AS ok FROM remote_following WHERE account_id = ? AND actor_uri = ?")
      .get("owner", "https://remote.example/users/alice") as { ok: number } | undefined;
    const identityFollow = db
      .prepare("SELECT 1 AS ok FROM remote_following WHERE account_id = ? AND actor_uri = ?")
      .get("identity1", "https://remote.example/users/alice") as { ok: number } | undefined;
    expect(ownerFollow?.ok).toBe(1);
    expect(identityFollow).toBeUndefined();
  });

  it("supports multi-actor unfollow with partial remote Undo failures", async () => {
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'identity')").run("identity1", "collective");
    db.prepare(
      "INSERT INTO identity_memberships (identity_account_id, member_account_id, role) VALUES (?, ?, 'editor')"
    ).run("identity1", "owner");
    db.prepare("UPDATE accounts SET private_key = ? WHERE id = ?").run("private-key-owner", "owner");
    db.prepare("UPDATE accounts SET private_key = ? WHERE id = ?").run("private-key-identity", "identity1");

    db.prepare(
      "INSERT INTO remote_following (account_id, actor_uri, actor_inbox, follow_activity_id, follow_object_uri) VALUES (?, ?, ?, ?, ?)"
    ).run("owner", "https://remote.example/users/alice", "https://remote.example/inbox", "https://local.example/users/owner#follows/own", "https://local.example/users/owner#follows/own");
    db.prepare(
      "INSERT INTO remote_following (account_id, actor_uri, actor_inbox, follow_activity_id, follow_object_uri) VALUES (?, ?, ?, ?, ?)"
    ).run("identity1", "https://remote.example/users/alice", "https://remote.example/inbox", "https://local.example/users/collective#follows/id1", "https://local.example/users/collective#follows/id1");

    vi.mocked(deliverActivity).mockImplementation(async (_inbox, activity) => {
      const actor = (activity as Record<string, unknown>).actor;
      return typeof actor === "string" ? actor.endsWith("/users/owner") : false;
    });

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/federation/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: "https://remote.example/users/alice", desiredAccountIds: [] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      removed: number;
      results: Array<{ accountId: string; status: string; remoteStatus?: string }>;
    };
    expect(body.removed).toBe(2);

    const ownerResult = body.results.find((row) => row.accountId === "owner");
    const identityResult = body.results.find((row) => row.accountId === "identity1");
    expect(ownerResult?.status).toBe("removed");
    expect(ownerResult?.remoteStatus).toBe("delivered");
    expect(identityResult?.status).toBe("removed");
    expect(identityResult?.remoteStatus).toBe("failed");

    const remaining = db
      .prepare("SELECT COUNT(*) AS count FROM remote_following WHERE actor_uri = ?")
      .get("https://remote.example/users/alice") as { count: number };
    expect(remaining.count).toBe(0);
  });
});
