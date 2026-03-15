import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase } from "../src/db.js";
import { feedRoutes } from "../src/routes/feeds.js";
import { privateFeedRoutes } from "../src/routes/private-feeds.js";
import { createApiCorsMiddleware } from "../src/middleware/api-cors.js";
import { authMiddleware, createSession } from "../src/middleware/auth.js";

function createApp() {
  const db = initDatabase(":memory:");
  const app = new Hono();
  app.use("/api/*", createApiCorsMiddleware(["https://app.everycal.test"]));
  app.use("*", authMiddleware(db));
  app.route("/api/v1/feeds", feedRoutes(db));
  app.route("/api/v1/private-feeds", privateFeedRoutes(db));
  return { app, db };
}

describe("feed CORS policy", () => {
  it("serves public feed endpoints with wildcard CORS and no credentials", async () => {
    const { app, db } = createApp();
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("u1", "alice");
    db.prepare(
      `INSERT INTO events (id, account_id, slug, title, start_date, all_day, visibility)
       VALUES (?, ?, ?, ?, ?, ?, 'public')`
    ).run("e1", "u1", "event-1", "Event 1", "2026-03-01", 1);

    const res = await app.request("http://localhost/api/v1/feeds/alice.json", {
      headers: { Origin: "https://embedder.example" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).not.toBe("true");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=900, stale-while-revalidate=300");
  });

  it("handles public feed preflight with minimal methods", async () => {
    const { app } = createApp();

    const res = await app.request("http://localhost/api/v1/feeds/alice.json", {
      method: "OPTIONS",
      headers: {
        Origin: "https://embedder.example",
        "Access-Control-Request-Method": "GET",
      },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-credentials")).not.toBe("true");
  });

  it("keeps calendar username JSON on wildcard CORS", async () => {
    const { app } = createApp();
    const res = await app.request("http://localhost/api/v1/feeds/calendar.json", {
      headers: { Origin: "https://embedder.example" },
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).not.toBe("true");
  });

  it("keeps private feed endpoints on strict CORS", async () => {
    const { app, db } = createApp();
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("u1", "alice");
    db.prepare("INSERT INTO calendar_feed_tokens (account_id, token) VALUES (?, ?)").run("u1", "tok1");

    const tokenRes = await app.request("http://localhost/api/v1/private-feeds/calendar.ics?token=tok1", {
      headers: { Origin: "https://embedder.example" },
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(tokenRes.headers.get("pragma")).toBe("no-cache");
    expect(tokenRes.headers.get("expires")).toBe("0");
    expect(tokenRes.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(tokenRes.headers.get("access-control-allow-origin")).toBeNull();
    expect(tokenRes.headers.get("access-control-allow-credentials")).toBeNull();

    const privateRes = await app.request("http://localhost/api/v1/private-feeds/calendar-url", {
      headers: { Origin: "https://embedder.example" },
    });
    expect(privateRes.status).toBe(401);
    expect(privateRes.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(privateRes.headers.get("access-control-allow-origin")).toBeNull();
    expect(privateRes.headers.get("access-control-allow-credentials")).toBeNull();

    const allowlistedRes = await app.request("http://localhost/api/v1/private-feeds/calendar.ics?token=tok1", {
      headers: { Origin: "https://app.everycal.test" },
    });
    expect(allowlistedRes.status).toBe(200);
    expect(allowlistedRes.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(allowlistedRes.headers.get("pragma")).toBe("no-cache");
    expect(allowlistedRes.headers.get("expires")).toBe("0");
    expect(allowlistedRes.headers.get("access-control-allow-origin")).toBe("https://app.everycal.test");
    expect(allowlistedRes.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("sets private feed no-store headers on token errors", async () => {
    const { app } = createApp();

    const missingTokenRes = await app.request("http://localhost/api/v1/private-feeds/calendar.ics");
    expect(missingTokenRes.status).toBe(400);
    expect(missingTokenRes.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(missingTokenRes.headers.get("pragma")).toBe("no-cache");
    expect(missingTokenRes.headers.get("expires")).toBe("0");

    const invalidTokenRes = await app.request("http://localhost/api/v1/private-feeds/calendar.ics?token=not-real");
    expect(invalidTokenRes.status).toBe(401);
    expect(invalidTokenRes.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(invalidTokenRes.headers.get("pragma")).toBe("no-cache");
    expect(invalidTokenRes.headers.get("expires")).toBe("0");
  });

  it("sets private feed no-store headers on calendar-url success", async () => {
    const { app, db } = createApp();
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("u1", "alice");
    const { token } = createSession(db, "u1");

    const res = await app.request("http://localhost/api/v1/private-feeds/calendar-url", {
      headers: { Cookie: `everycal_session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(res.headers.get("pragma")).toBe("no-cache");
    expect(res.headers.get("expires")).toBe("0");
  });
});

describe("public feed visibility", () => {
  it("includes reposted unlisted events but excludes other unlisted events", async () => {
    const { app, db } = createApp();
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("alice-id", "alice");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("bob-id", "bob");

    db.prepare(
      `INSERT INTO events (id, account_id, slug, title, start_date, all_day, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("alice-public", "alice-id", "alice-public", "Alice Public", "2026-03-01", 1, "public");

    db.prepare(
      `INSERT INTO events (id, account_id, slug, title, start_date, all_day, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("alice-unlisted", "alice-id", "alice-unlisted", "Alice Unlisted", "2026-03-02", 1, "unlisted");

    db.prepare(
      `INSERT INTO events (id, account_id, slug, title, start_date, all_day, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("bob-unlisted-reposted", "bob-id", "bob-u1", "Bob Unlisted Reposted", "2026-03-03", 1, "unlisted");

    db.prepare(
      `INSERT INTO events (id, account_id, slug, title, start_date, all_day, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("bob-unlisted-hidden", "bob-id", "bob-u2", "Bob Unlisted Hidden", "2026-03-04", 1, "unlisted");

    db.prepare("INSERT INTO reposts (account_id, event_id) VALUES (?, ?)").run("alice-id", "bob-unlisted-reposted");

    const res = await app.request("http://localhost/api/v1/feeds/alice.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ id: string }> };
    const ids = body.events.map((event) => event.id);

    expect(ids).toContain("alice-public");
    expect(ids).toContain("bob-unlisted-reposted");
    expect(ids).not.toContain("alice-unlisted");
    expect(ids).not.toContain("bob-unlisted-hidden");
  });
});
