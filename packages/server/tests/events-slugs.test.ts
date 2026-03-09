import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/lib/federation.js", () => ({
  fetchAP: vi.fn(),
  resolveRemoteActor: vi.fn(),
  deliverToFollowers: vi.fn(),
}));

import { eventRoutes } from "../src/routes/events.js";
import { upsertRemoteEvent } from "../src/lib/remote-events.js";
import { fetchAP, resolveRemoteActor, deliverToFollowers } from "../src/lib/federation.js";

function makeApp(db: DB, user: { id: string; username: string } | null = null) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (user) c.set("user", { ...user, displayName: user.username });
    await next();
  });
  app.route("/api/v1/events", eventRoutes(db));
  return app;
}

describe("event slug canonical behavior", () => {
  let db: DB;

  beforeEach(() => {
    db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("u1", "alice");
    vi.mocked(fetchAP).mockReset();
    vi.mocked(resolveRemoteActor).mockReset();
    vi.mocked(deliverToFollowers).mockResolvedValue(true as any);
  });

  it("keeps local slug immutable on title update", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });
    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Original Title", startDate: "2026-01-01T10:00:00Z" }),
    });
    const created = await create.json() as { id: string; slug: string };

    const update = await app.request(`http://localhost/api/v1/events/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed Title" }),
    });
    const updated = await update.json() as { slug: string };

    expect(update.status).toBe(200);
    expect(updated.slug).toBe(created.slug);
  });

  it("creates remote slug once and keeps it immutable on update", () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");

    const first = upsertRemoteEvent(db, {
      id: "https://remote.example/events/1",
      type: "Event",
      name: "Same Event",
      startTime: "2026-01-02T10:00:00Z",
    }, "https://remote.example/users/alice");

    const second = upsertRemoteEvent(db, {
      id: "https://remote.example/events/1",
      type: "Event",
      name: "Changed Name",
      startTime: "2026-01-02T10:00:00Z",
    }, "https://remote.example/users/alice");

    expect(first.slug).toBe("same-event");
    expect(second.slug).toBe("same-event");
  });

  it("persists missing slug on remote update with actor-scoped uniqueness", () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, slug, title, start_date) VALUES (?, ?, ?, ?, ?)")
      .run("https://remote.example/events/other", "https://remote.example/users/alice", "same-event", "Same Event", "2026-01-02T10:00:00Z");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, title, start_date) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/events/target", "https://remote.example/users/alice", "Same Event", "2026-01-02T10:00:00Z");

    const updated = upsertRemoteEvent(db, {
      id: "https://remote.example/events/target",
      type: "Event",
      name: "Same Event",
      startTime: "2026-01-03T10:00:00Z",
    }, "https://remote.example/users/alice");

    expect(updated.slug).toBe("same-event-2");
    const row = db.prepare("SELECT slug FROM remote_events WHERE uri = ?").get("https://remote.example/events/target") as { slug: string };
    expect(row.slug).toBe("same-event-2");
  });

  it("handles remote slug collisions per actor", () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/bob", "bob", "https://remote.example/inbox", "remote.example");

    const a1 = upsertRemoteEvent(db, { id: "https://remote.example/events/a1", type: "Event", name: "Party", startTime: "2026-01-02T10:00:00Z" }, "https://remote.example/users/alice");
    const a2 = upsertRemoteEvent(db, { id: "https://remote.example/events/a2", type: "Event", name: "Party", startTime: "2026-01-03T10:00:00Z" }, "https://remote.example/users/alice");
    const b1 = upsertRemoteEvent(db, { id: "https://remote.example/events/b1", type: "Event", name: "Party", startTime: "2026-01-04T10:00:00Z" }, "https://remote.example/users/bob");

    expect(a1.slug).toBe("party");
    expect(a2.slug).toBe("party-2");
    expect(b1.slug).toBe("party");
  });

  it("/events/by-slug/:username/:slug resolves local and remote", async () => {
    db.prepare("INSERT INTO events (id, account_id, slug, title, start_date, visibility) VALUES (?, ?, ?, ?, ?, 'public')")
      .run("e-local", "u1", "local-slug", "Local", "2026-01-01T10:00:00Z");
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, slug, title, start_date) VALUES (?, ?, ?, ?, ?)")
      .run("https://remote.example/events/1", "https://remote.example/users/alice", "remote-slug", "Remote", "2026-01-01T10:00:00Z");

    const app = makeApp(db, { id: "u1", username: "alice" });
    const localRes = await app.request("http://localhost/api/v1/events/by-slug/alice/local-slug");
    const remoteRes = await app.request("http://localhost/api/v1/events/by-slug/alice@remote.example/remote-slug");

    expect(localRes.status).toBe(200);
    expect(remoteRes.status).toBe(200);
    expect((await remoteRes.json() as { source: string }).source).toBe("remote");
  });

  it("resolver bootstraps unfetched remote event and returns canonical path", async () => {
    vi.mocked(fetchAP).mockResolvedValue({
      id: "https://remote.example/events/99",
      type: "Event",
      name: "Resolver Event",
      startTime: "2026-01-01T10:00:00Z",
      attributedTo: "https://remote.example/users/alice",
    });
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: "https://remote.example/users/alice",
      preferred_username: "alice",
      display_name: "Alice",
      inbox: "https://remote.example/inbox",
      domain: "remote.example",
    } as any);

    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events/resolve?uri=https%3A%2F%2Fremote.example%2Fevents%2F99");
    const body = await res.json() as { path: string };

    expect(res.status).toBe(200);
    expect(body.path).toBe("/@alice@remote.example/resolver-event");
  });

  it("resolver redirects to canonical path for browser navigations", async () => {
    vi.mocked(fetchAP).mockResolvedValue({
      id: "https://remote.example/events/100",
      type: "Event",
      name: "Resolver Redirect Event",
      startTime: "2026-01-01T10:00:00Z",
      attributedTo: "https://remote.example/users/alice",
    });
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: "https://remote.example/users/alice",
      preferred_username: "alice",
      display_name: "Alice",
      inbox: "https://remote.example/inbox",
      domain: "remote.example",
    } as any);

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events/resolve?uri=https%3A%2F%2Fremote.example%2Fevents%2F100", {
      headers: { accept: "text/html" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/@alice@remote.example/resolver-redirect-event");
  });

  it("resolver returns controlled 502 on remote fetch failures", async () => {
    vi.mocked(fetchAP).mockRejectedValue(new Error("upstream timeout"));
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events/resolve?uri=https%3A%2F%2Fremote.example%2Fevents%2F100");
    const body = await res.json() as { error: string };

    expect(res.status).toBe(502);
    expect(body.error).toContain("Failed to resolve remote event");
  });

  it("resolver assigns slug for existing cached remote event without slug", async () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://events.htu.at/users/htu", "htu", "https://events.htu.at/inbox", "events.htu.at");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, title, start_date) VALUES (?, ?, ?, ?)")
      .run(
        "https://events.htu.at/events/13064e2e-f644-4b7d-8421-c280ad93b066",
        "https://events.htu.at/users/htu",
        "HTU Event",
        "2026-01-01T10:00:00Z",
      );

    const app = makeApp(db);
    const res = await app.request(
      "http://localhost/api/v1/events/resolve?uri=https%3A%2F%2Fevents.htu.at%2Fevents%2F13064e2e-f644-4b7d-8421-c280ad93b066"
    );
    const body = await res.json() as { path: string };

    expect(res.status).toBe(200);
    expect(body.path).toBe("/@htu@events.htu.at/htu-event");
    expect(vi.mocked(fetchAP)).not.toHaveBeenCalled();
  });

  it("old base64 remote route is no longer supported", async () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, slug, title, start_date) VALUES (?, ?, ?, ?, ?)")
      .run("https://remote.example/events/1", "https://remote.example/users/alice", "remote-slug", "Remote", "2026-01-01T10:00:00Z");

    const oldId = Buffer.from("https://remote.example/events/1").toString("base64url");
    const app = makeApp(db);
    const res = await app.request(`http://localhost/api/v1/events/${oldId}`);
    expect(res.status).toBe(404);
  });

  it("migrates existing remote_events table without slug column", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "legacy.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE remote_events (
        uri TEXT PRIMARY KEY,
        actor_uri TEXT NOT NULL,
        title TEXT NOT NULL,
        start_date TEXT NOT NULL
      );
    `);
    legacy.close();

    const migrated = initDatabase(dbPath);
    const cols = migrated.prepare("PRAGMA table_info(remote_events)").all() as Array<{ name: string }>;
    const hasSlug = cols.some((c) => c.name === "slug");
    expect(hasSlug).toBe(true);
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
