import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { initDatabase, type DB } from "../src/db.js";
import { authRoutes } from "../src/routes/auth.js";
import { eventRoutes } from "../src/routes/events.js";
import { locationRoutes } from "../src/routes/locations.js";
import { uploadRoutes } from "../src/routes/uploads.js";
import { serveUploadsRoutes } from "../src/routes/serve-uploads.js";
import { hashPassword } from "../src/middleware/auth.js";
import { hashTokenSecret } from "../src/lib/token-secrets.js";
import { PaginationParamError, parseLimitOffset } from "../src/lib/pagination.js";
import { UPLOAD_DIR } from "../src/lib/paths.js";

function makeApp(db: DB, user: { id: string; username: string } | null = null) {
  const app = new Hono();
  app.use("/api/v1/uploads*", bodyLimit({ maxSize: 6 * 1024 * 1024, onError: (c) => c.json({ error: "too large" }, 413) }));
  const defaultApiBodyLimit = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: "too large" }, 413) });
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/v1/uploads")) {
      await next();
      return;
    }
    return defaultApiBodyLimit(c, next);
  });
  app.use("*", async (c, next) => {
    if (user) c.set("user", user);
    await next();
  });
  app.route("/api/v1/auth", authRoutes(db));
  app.route("/api/v1/events", eventRoutes(db));
  app.route("/api/v1/locations", locationRoutes(db));
  app.route("/api/v1/uploads", uploadRoutes());
  app.route("/uploads", serveUploadsRoutes());
  return app;
}

describe("api hardening and pagination", () => {
  let db: DB;

  beforeEach(() => {
    process.env.OPEN_REGISTRATIONS = "true";
    db = initDatabase(":memory:");
  });

  it("returns 400 for malformed JSON on auth and events routes", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("u1", "alice");

    const authRes = await app.request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(authRes.status).toBe(400);

    const rsvpRes = await app.request("http://localhost/api/v1/events/rsvp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(rsvpRes.status).toBe(400);
  });

  it("stores reset tokens hashed and resolves hashed lookup", async () => {
    db.prepare("INSERT INTO accounts (id, username, email, email_verified, is_bot) VALUES (?, ?, ?, 1, 0)")
      .run("u2", "bob", "bob@example.com");
    const app = makeApp(db);

    await app.request("http://localhost/api/v1/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@example.com" }),
    });

    const stored = db.prepare("SELECT token FROM password_reset_tokens WHERE account_id = ?").get("u2") as { token: string };
    expect(stored.token).toMatch(/^[a-f0-9]{64}$/);

    db.prepare("UPDATE password_reset_tokens SET token = ? WHERE account_id = ?").run(hashTokenSecret("known-token"), "u2");
    const resetRes = await app.request("http://localhost/api/v1/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "known-token", newPassword: "new-password-123" }),
    });
    expect(resetRes.status).toBe(200);
  });

  it("does not allow toggling isBot via auth endpoints", async () => {
    db.prepare("INSERT INTO accounts (id, username, password_hash, email_verified, is_bot) VALUES (?, ?, ?, 1, 0)")
      .run("u3", "carol", hashPassword("pw"));
    const app = makeApp(db, { id: "u3", username: "carol" });

    const registerRes = await app.request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "x", isBot: true }),
    });
    expect(registerRes.status).toBe(400);

    const patchRes = await app.request("http://localhost/api/v1/auth/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isBot: true, displayName: "Carol" }),
    });
    expect(patchRes.status).toBe(200);
    const row = db.prepare("SELECT is_bot FROM accounts WHERE id = ?").get("u3") as { is_bot: number };
    expect(row.is_bot).toBe(0);
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

  it("keeps upload source bytes unchanged across repeated reads", async () => {
    mkdirSync(UPLOAD_DIR, { recursive: true });
    const filename = "idempotent-test.png";
    const filePath = join(UPLOAD_DIR, filename);
    const source = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 120, b: 240, alpha: 1 } } }).png().toBuffer();
    writeFileSync(filePath, source);

    const app = makeApp(db);
    const before = readFileSync(filePath);
    const first = await app.request(`http://localhost/uploads/${filename}`);
    const second = await app.request(`http://localhost/uploads/${filename}`);
    const after = readFileSync(filePath);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.compare(before, after)).toBe(0);

    rmSync(filePath, { force: true });
  });

  it("upserts saved locations with null address without duplicates", async () => {
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("u6", "frank");
    const app = makeApp(db, { id: "u6", username: "frank" });

    await app.request("http://localhost/api/v1/locations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "HQ", latitude: 1, longitude: 2 }),
    });
    await app.request("http://localhost/api/v1/locations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "HQ", latitude: 3, longitude: 4 }),
    });

    const rows = db.prepare("SELECT id, latitude FROM saved_locations WHERE account_id = ? AND name = ?").all("u6", "HQ") as Array<{ id: number; latitude: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].latitude).toBe(3);
  });

  it("pagination parser rejects invalid values and applies caps", async () => {
    const app = new Hono();
    app.get("/", (c) => {
      try {
        const parsed = parseLimitOffset(c, { defaultLimit: 12, maxLimit: 30 });
        return c.json(parsed);
      } catch (error) {
        if (error instanceof PaginationParamError) return c.json({ error: error.message }, 400);
        throw error;
      }
    });

    const capped = await app.request("http://localhost/?limit=999");
    expect(capped.status).toBe(200);
    await expect(capped.json()).resolves.toEqual({ limit: 30, offset: 0 });

    const invalid = await app.request("http://localhost/?limit=-1");
    expect(invalid.status).toBe(400);
  });

  it("allows uploads above 1MB while keeping 1MB default API limit", async () => {
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("u7", "gina");
    const app = makeApp(db, { id: "u7", username: "gina" });

    const width = 900;
    const height = 900;
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = i % 251;
    const image = await sharp(raw, { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(image.length).toBeGreaterThan(1024 * 1024);
    expect(image.length).toBeLessThan(6 * 1024 * 1024);

    const formData = new FormData();
    formData.append("file", new File([image], "big.png", { type: "image/png" }));
    const uploadRes = await app.request("http://localhost/api/v1/uploads", {
      method: "POST",
      body: formData,
    });
    expect(uploadRes.status).toBe(201);

    const tooLargeJson = JSON.stringify({ username: "x", password: "y".repeat(1024 * 1024) });
    const authRes = await app.request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: tooLargeJson,
    });
    expect(authRes.status).toBe(413);
  });
});
