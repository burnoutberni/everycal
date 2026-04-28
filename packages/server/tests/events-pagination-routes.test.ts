import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { eventRoutes } from "../src/routes/events.js";

function makeApp(db: DB, user: { id: string; username: string } | null = null) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (user) c.set("user", user);
    await next();
  });
  app.route("/api/v1/events", eventRoutes(db));
  return app;
}

describe("events pagination routes", () => {
  let db: DB;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  it("returns 400 for malformed JSON on events rsvp route", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("u1", "alice");

    const res = await app.request("http://localhost/api/v1/events/rsvp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
  });

  it("paginates merged local+remote events without duplicates across cursor pages", async () => {
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("u4", "dana");
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("u5", "erin");
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote/users/a", "a", "https://remote/inbox", "remote");

    db.prepare(`INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, all_day, visibility)
      VALUES (?, ?, ?, ?, ?, ?, 'UTC', 1, 'public')`).run("l1", "u4", "l1", "Local1", "2026-01-01", "2026-01-01T00:00:00.000Z");
    db.prepare(`INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, all_day, visibility)
      VALUES (?, ?, ?, ?, ?, ?, 'UTC', 1, 'public')`).run("l2", "u5", "l2", "Local2", "2026-01-02", "2026-01-02T00:00:00.000Z");
    db.prepare(`INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality)
      VALUES (?, ?, ?, ?, ?, 'offset_only')`).run("r1", "https://remote/users/a", "Remote1", "2026-01-03", "2026-01-03T00:00:00.000Z");

    const app = makeApp(db);
    const p1 = await app.request("http://localhost/api/v1/events?limit=2");
    const b1 = await p1.json() as { events: Array<{ id: string }>; nextCursor: string | null };
    const p2 = await app.request(`http://localhost/api/v1/events?limit=2&cursor=${encodeURIComponent(b1.nextCursor || "")}`);
    const b2 = await p2.json() as { events: Array<{ id: string }> };

    const ids = [...b1.events, ...b2.events].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["l1", "l2", "r1"]);
  });

  it("returns 400 when events cursor is invalid", async () => {
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events?limit=2&cursor=not-a-valid-cursor");
    const body = await res.json() as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/cursor/i);
  });

  it("keeps merged cursor pagination stable when tie-break ids differ by case", async () => {
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("u6", "case-local");
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote/users/case", "case", "https://remote/inbox", "remote");

    db.prepare(`INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, all_day, visibility)
      VALUES (?, ?, ?, ?, ?, ?, 'UTC', 1, 'public')`).run("a", "u6", "a", "Local A", "2026-01-10", "2026-01-10T00:00:00.000Z");
    db.prepare(`INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality)
      VALUES (?, ?, ?, ?, ?, 'offset_only')`).run("A", "https://remote/users/case", "Remote A", "2026-01-10", "2026-01-10T00:00:00.000Z");

    const app = makeApp(db);
    const p1 = await app.request("http://localhost/api/v1/events?limit=1");
    const b1 = await p1.json() as { events: Array<{ id: string }>; nextCursor: string | null };
    const p2 = await app.request(`http://localhost/api/v1/events?limit=1&cursor=${encodeURIComponent(b1.nextCursor || "")}`);
    const b2 = await p2.json() as { events: Array<{ id: string }> };

    const ids = [...b1.events, ...b2.events].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["A", "a"]);
  });

  it("applies merged offset pagination without loading a single source only", async () => {
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("u40", "local-a");
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("u41", "local-b");
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote/users/off", "off", "https://remote/inbox", "remote");

    db.prepare(`INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, all_day, visibility)
      VALUES (?, ?, ?, ?, ?, ?, 'UTC', 1, 'public')`).run("l1", "u40", "l1", "Local1", "2026-02-01", "2026-02-01T00:00:00.000Z");
    db.prepare(`INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, all_day, visibility)
      VALUES (?, ?, ?, ?, ?, ?, 'UTC', 1, 'public')`).run("l2", "u41", "l2", "Local2", "2026-02-02", "2026-02-02T00:00:00.000Z");
    db.prepare(`INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality)
      VALUES (?, ?, ?, ?, ?, 'offset_only')`).run("r1", "https://remote/users/off", "Remote1", "2026-02-03", "2026-02-03T00:00:00.000Z");
    db.prepare(`INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, all_day, visibility)
      VALUES (?, ?, ?, ?, ?, ?, 'UTC', 1, 'public')`).run("l3", "u40", "l3", "Local3", "2026-02-04", "2026-02-04T00:00:00.000Z");
    db.prepare(`INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, all_day, visibility)
      VALUES (?, ?, ?, ?, ?, ?, 'UTC', 1, 'public')`).run("l4", "u41", "l4", "Local4", "2026-02-05", "2026-02-05T00:00:00.000Z");
    db.prepare(`INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, all_day, visibility)
      VALUES (?, ?, ?, ?, ?, ?, 'UTC', 1, 'public')`).run("l5", "u40", "l5", "Local5", "2026-02-06", "2026-02-06T00:00:00.000Z");

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events?limit=2&offset=4");
    const body = await res.json() as { events: Array<{ id: string }> };

    expect(res.status).toBe(200);
    expect(body.events.map((event) => event.id)).toEqual(["l4", "l5"]);
  });

  it("paginates local source with cursor using stable tie-break ordering", async () => {
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("u50", "local-tie");

    db.prepare(`INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, all_day, visibility)
      VALUES (?, ?, ?, ?, ?, ?, 'UTC', 1, 'public')`).run("b", "u50", "b", "Local B", "2026-03-01", "2026-03-01T00:00:00.000Z");
    db.prepare(`INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, all_day, visibility)
      VALUES (?, ?, ?, ?, ?, ?, 'UTC', 1, 'public')`).run("a", "u50", "a", "Local A", "2026-03-01", "2026-03-01T00:00:00.000Z");
    db.prepare(`INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, all_day, visibility)
      VALUES (?, ?, ?, ?, ?, ?, 'UTC', 1, 'public')`).run("c", "u50", "c", "Local C", "2026-03-02", "2026-03-02T00:00:00.000Z");

    const app = makeApp(db);
    const first = await app.request("http://localhost/api/v1/events?source=local&limit=1");
    const firstBody = await first.json() as { events: Array<{ id: string }>; nextCursor: string | null };
    const second = await app.request(`http://localhost/api/v1/events?source=local&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor || "")}`);
    const secondBody = await second.json() as { events: Array<{ id: string }>; nextCursor: string | null };
    const third = await app.request(`http://localhost/api/v1/events?source=local&limit=1&cursor=${encodeURIComponent(secondBody.nextCursor || "")}`);
    const thirdBody = await third.json() as { events: Array<{ id: string }>; nextCursor: string | null };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    const ids = [...firstBody.events, ...secondBody.events, ...thirdBody.events].map((event) => event.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(firstBody.nextCursor).not.toBeNull();
    expect(secondBody.nextCursor).not.toBeNull();
    expect(thirdBody.nextCursor).toBeNull();
  });

  it("paginates remote source with cursor using stable tie-break ordering", async () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote/users/remote-only", "remote-only", "https://remote/inbox", "remote");

    db.prepare(`INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality)
      VALUES (?, ?, ?, ?, ?, 'offset_only')`).run("rb", "https://remote/users/remote-only", "Remote B", "2026-04-01", "2026-04-01T00:00:00.000Z");
    db.prepare(`INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality)
      VALUES (?, ?, ?, ?, ?, 'offset_only')`).run("ra", "https://remote/users/remote-only", "Remote A", "2026-04-01", "2026-04-01T00:00:00.000Z");
    db.prepare(`INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality)
      VALUES (?, ?, ?, ?, ?, 'offset_only')`).run("rc", "https://remote/users/remote-only", "Remote C", "2026-04-02", "2026-04-02T00:00:00.000Z");

    const app = makeApp(db);
    const first = await app.request("http://localhost/api/v1/events?source=remote&limit=1");
    const firstBody = await first.json() as { events: Array<{ id: string }>; nextCursor: string | null };
    const second = await app.request(`http://localhost/api/v1/events?source=remote&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor || "")}`);
    const secondBody = await second.json() as { events: Array<{ id: string }>; nextCursor: string | null };
    const third = await app.request(`http://localhost/api/v1/events?source=remote&limit=1&cursor=${encodeURIComponent(secondBody.nextCursor || "")}`);
    const thirdBody = await third.json() as { events: Array<{ id: string }>; nextCursor: string | null };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    const ids = [...firstBody.events, ...secondBody.events, ...thirdBody.events].map((event) => event.id);
    expect(ids).toEqual(["ra", "rb", "rc"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(firstBody.nextCursor).not.toBeNull();
    expect(secondBody.nextCursor).not.toBeNull();
    expect(thirdBody.nextCursor).toBeNull();
  });

  it("paginates timeline local+remote events without duplicates across cursor pages", async () => {
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("viewer", "viewer");
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("local-author", "local-author");
    db.prepare("INSERT INTO follows (follower_id, following_id) VALUES (?, ?)").run("viewer", "local-author");
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote/users/timeline", "timeline", "https://remote/inbox", "remote");
    db.prepare("INSERT INTO remote_following (account_id, actor_uri, actor_inbox) VALUES (?, ?, ?)")
      .run("viewer", "https://remote/users/timeline", "https://remote/inbox");

    db.prepare(`INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, all_day, visibility)
      VALUES (?, ?, ?, ?, ?, ?, 'UTC', 1, 'public')`).run("t-local-1", "local-author", "t-local-1", "Timeline Local 1", "2026-07-01", "2026-07-01T00:00:00.000Z");
    db.prepare(`INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, all_day, visibility)
      VALUES (?, ?, ?, ?, ?, ?, 'UTC', 1, 'public')`).run("t-local-2", "local-author", "t-local-2", "Timeline Local 2", "2026-07-02", "2026-07-02T00:00:00.000Z");
    db.prepare(`INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality)
      VALUES (?, ?, ?, ?, ?, 'offset_only')`).run("t-remote-1", "https://remote/users/timeline", "Timeline Remote 1", "2026-07-03", "2026-07-03T00:00:00.000Z");

    const app = makeApp(db, { id: "viewer", username: "viewer" });
    const first = await app.request("http://localhost/api/v1/events/timeline?limit=2&from=2026-06-01T00:00:00.000Z");
    const firstBody = await first.json() as { events: Array<{ id: string }>; nextCursor: string | null };
    const second = await app.request(`http://localhost/api/v1/events/timeline?limit=2&from=2026-06-01T00:00:00.000Z&cursor=${encodeURIComponent(firstBody.nextCursor || "")}`);
    const secondBody = await second.json() as { events: Array<{ id: string }> };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const ids = [...firstBody.events, ...secondBody.events].map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["t-local-1", "t-local-2", "t-remote-1"]);
  });

  it("returns 400 when timeline cursor is invalid", async () => {
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("viewer-invalid-cursor", "viewer-invalid-cursor");

    const app = makeApp(db, { id: "viewer-invalid-cursor", username: "viewer-invalid-cursor" });
    const res = await app.request(
      "http://localhost/api/v1/events/timeline?limit=2&from=2026-06-01T00:00:00.000Z&cursor=not-a-valid-cursor"
    );
    const body = await res.json() as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/cursor/i);
  });
});
