import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase } from "../src/db.js";
import { userRoutes } from "../src/routes/users.js";
import { directoryRoutes } from "../src/routes/directory.js";

function createAppWithRemoteRepost() {
  const db = initDatabase(":memory:");
  const app = new Hono();
  app.route("/api/v1/users", userRoutes(db));
  app.route("/api/v1", directoryRoutes(db));

  db.prepare("INSERT INTO accounts (id, username, account_type, discoverable) VALUES (?, ?, 'person', 1)").run("u1", "alice");
  db.prepare(
    "INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "https://remote.example/events/1",
    "https://remote.example/users/bob",
    "Remote event",
    "2026-05-20",
    "2026-05-20T09:00:00Z",
    "offset_only",
    "public",
  );
  db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)").run(
    "u1",
    null,
    "https://remote.example/events/1",
    "https://remote.example/users/bob",
  );

  return { app };
}

function createAppWithUnreadableRemoteReposts() {
  const db = initDatabase(":memory:");
  const app = new Hono();
  app.route("/api/v1/users", userRoutes(db));
  app.route("/api/v1", directoryRoutes(db));

  db.prepare("INSERT INTO accounts (id, username, account_type, discoverable) VALUES (?, ?, 'person', 1)").run("u1", "alice");
  db.prepare("INSERT INTO remote_actors (uri, type, preferred_username, inbox, outbox, domain) VALUES (?, 'Person', 'bob', ?, ?, 'remote.example')")
    .run("https://remote.example/users/bob", "https://remote.example/inbox", "https://remote.example/users/bob/outbox");
  db.prepare("INSERT INTO remote_actors (uri, type, preferred_username, inbox, outbox, domain) VALUES (?, 'Person', 'mallory', ?, ?, 'blocked.example')")
    .run("https://blocked.example/users/mallory", "https://blocked.example/inbox", "https://blocked.example/users/mallory/outbox");

  const insertRemoteEvent = db.prepare(
    "INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insertRemoteEvent.run(
    "https://remote.example/events/visible",
    "https://remote.example/users/bob",
    "Visible remote event",
    "2026-05-20",
    "2026-05-20T09:00:00Z",
    "offset_only",
    "public",
  );
  insertRemoteEvent.run(
    "https://remote.example/events/hidden",
    "https://remote.example/users/bob",
    "Hidden remote event",
    "2026-05-21",
    "2026-05-21T09:00:00Z",
    "offset_only",
    "public",
  );
  insertRemoteEvent.run(
    "https://remote.example/events/tombstoned",
    "https://remote.example/users/bob",
    "Tombstoned remote event",
    "2026-05-22",
    "2026-05-22T09:00:00Z",
    "offset_only",
    "public",
  );
  insertRemoteEvent.run(
    "https://blocked.example/events/blocked",
    "https://blocked.example/users/mallory",
    "Blocked remote event",
    "2026-05-23",
    "2026-05-23T09:00:00Z",
    "offset_only",
    "public",
  );

  db.prepare("UPDATE remote_events SET moderation_state = 'hidden' WHERE uri = ?")
    .run("https://remote.example/events/hidden");
  db.prepare(
    "INSERT INTO federation_tombstones (id, object_type, object_id, reason) VALUES (?, 'remote_event', ?, 'test tombstone')",
  ).run("remote-event:https://remote.example/events/tombstoned", "https://remote.example/events/tombstoned");
  db.prepare(
    "INSERT INTO federation_blocks (id, block_type, domain, reason, created_by_account_id, is_active) VALUES (?, 'domain', 'blocked.example', 'blocked', 'admin-1', 1)",
  ).run("block-domain-blocked-example");

  db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)").run(
    "u1",
    null,
    "https://remote.example/events/visible",
    "https://remote.example/users/bob",
  );
  db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)").run(
    "u1",
    null,
    "https://remote.example/events/hidden",
    "https://remote.example/users/bob",
  );
  db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)").run(
    "u1",
    null,
    "https://remote.example/events/tombstoned",
    "https://remote.example/users/bob",
  );
  db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)").run(
    "u1",
    null,
    "https://blocked.example/events/blocked",
    "https://blocked.example/users/mallory",
  );

  return { app };
}

describe("users and directory event counts", () => {
  it("counts direct reposts of remote events consistently", async () => {
    const { app } = createAppWithRemoteRepost();

    const usersRes = await app.request("http://localhost/api/v1/users");
    expect(usersRes.status).toBe(200);
    const usersBody = (await usersRes.json()) as { users: Array<{ username: string; eventsCount: number }> };
    const aliceUser = usersBody.users.find((u) => u.username === "alice");
    expect(aliceUser?.eventsCount).toBe(1);

    const profileRes = await app.request("http://localhost/api/v1/users/alice");
    expect(profileRes.status).toBe(200);
    const profileBody = (await profileRes.json()) as { eventsCount: number };
    expect(profileBody.eventsCount).toBe(1);

    const directoryRes = await app.request("http://localhost/api/v1/directory");
    expect(directoryRes.status).toBe(200);
    const directoryBody = (await directoryRes.json()) as Array<{ username: string; statuses_count: number }>;
    const aliceDirectory = directoryBody.find((u) => u.username === "alice");
    expect(aliceDirectory?.statuses_count).toBe(1);
  });

  it("keeps counts isolated per account and dedupes per account", async () => {
    const db = initDatabase(":memory:");
    const app = new Hono();
    app.route("/api/v1/users", userRoutes(db));
    app.route("/api/v1", directoryRoutes(db));

    db.prepare("INSERT INTO accounts (id, username, account_type, discoverable) VALUES (?, ?, 'person', 1)").run("u1", "alice");
    db.prepare("INSERT INTO accounts (id, username, account_type, discoverable) VALUES (?, ?, 'person', 1)").run("u2", "bob");

    db.prepare(
      "INSERT INTO events (id, account_id, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("e1", "u1", "Local event", "2026-06-01", "2026-06-01T10:00:00Z", "UTC", "public");

    db.prepare(
      "INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)",
    ).run("u1", "e1", "http://localhost/events/e1", "https://localhost/users/alice");

    db.prepare(
      "INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)",
    ).run("u2", "e1", "http://localhost/events/e1", "https://localhost/users/alice");

    const usersRes = await app.request("http://localhost/api/v1/users");
    expect(usersRes.status).toBe(200);
    const usersBody = (await usersRes.json()) as { users: Array<{ username: string; eventsCount: number }> };

    const alice = usersBody.users.find((u) => u.username === "alice");
    const bob = usersBody.users.find((u) => u.username === "bob");
    expect(alice?.eventsCount).toBe(1);
    expect(bob?.eventsCount).toBe(1);

    const directoryRes = await app.request("http://localhost/api/v1/directory");
    expect(directoryRes.status).toBe(200);
    const directoryBody = (await directoryRes.json()) as Array<{ username: string; statuses_count: number }>;
    const aliceDirectory = directoryBody.find((u) => u.username === "alice");
    const bobDirectory = directoryBody.find((u) => u.username === "bob");
    expect(aliceDirectory?.statuses_count).toBe(1);
    expect(bobDirectory?.statuses_count).toBe(1);
  });

  it("excludes blocked, tombstoned, and hidden remote reposts from public counts", async () => {
    const { app } = createAppWithUnreadableRemoteReposts();

    const usersRes = await app.request("http://localhost/api/v1/users");
    expect(usersRes.status).toBe(200);
    const usersBody = (await usersRes.json()) as { users: Array<{ username: string; eventsCount: number }> };
    const aliceUser = usersBody.users.find((u) => u.username === "alice");
    expect(aliceUser?.eventsCount).toBe(1);

    const profileRes = await app.request("http://localhost/api/v1/users/alice");
    expect(profileRes.status).toBe(200);
    const profileBody = (await profileRes.json()) as { eventsCount: number };
    expect(profileBody.eventsCount).toBe(1);

    const directoryRes = await app.request("http://localhost/api/v1/directory");
    expect(directoryRes.status).toBe(200);
    const directoryBody = (await directoryRes.json()) as Array<{ username: string; statuses_count: number }>;
    const aliceDirectory = directoryBody.find((u) => u.username === "alice");
    expect(aliceDirectory?.statuses_count).toBe(1);
  });
});
