import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { wellKnownRoutes, nodeInfoRoutes } from "../src/routes/well-known.js";

function makeApp(db: DB) {
  const app = new Hono();
  app.route("/.well-known", wellKnownRoutes(db));
  app.route("/nodeinfo", nodeInfoRoutes(db));
  return app;
}

describe("well-known routes", () => {
  let db: DB;

  beforeEach(() => {
    process.env.BASE_URL = "http://localhost:3000";
    db = initDatabase(":memory:");
  });

  describe("GET /.well-known/webfinger", () => {
    it("returns JRD with correct links for valid account", async () => {
      db.prepare("INSERT INTO accounts (id, username) VALUES (?, ?)").run("u1", "alice");
      const app = makeApp(db);

      const res = await app.request("http://localhost:3000/.well-known/webfinger?resource=acct:alice@localhost");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/jrd+json");

      const body = await res.json();
      expect(body.subject).toBe("acct:alice@localhost");
      expect(body.aliases).toBeDefined();
      expect(body.links).toBeDefined();

      const selfLink = body.links.find((l: { rel: string }) => l.rel === "self");
      expect(selfLink).toBeDefined();
      expect(selfLink.type).toBe("application/activity+json");
      expect(selfLink.href).toContain("/users/alice");
    });

    it("returns 400 when resource parameter is missing", async () => {
      const app = makeApp(db);
      const res = await app.request("http://localhost:3000/.well-known/webfinger");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it("returns 400 for invalid resource format", async () => {
      const app = makeApp(db);
      const res = await app.request("http://localhost:3000/.well-known/webfinger?resource=invalid");
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown domain", async () => {
      const app = makeApp(db);
      const res = await app.request("http://localhost:3000/.well-known/webfinger?resource=acct:alice@evil.com");
      expect(res.status).toBe(404);
    });

    it("returns 404 for unknown user", async () => {
      const app = makeApp(db);
      const res = await app.request("http://localhost:3000/.well-known/webfinger?resource=acct:nonexistent@localhost");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /.well-known/nodeinfo", () => {
    it("returns nodeinfo link document", async () => {
      const app = makeApp(db);
      const res = await app.request("http://localhost:3000/.well-known/nodeinfo");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.links).toBeDefined();
      expect(Array.isArray(body.links)).toBe(true);

      const nodeInfoLink = body.links.find(
        (l: { rel: string }) => l.rel === "http://nodeinfo.diaspora.software/ns/schema/2.0"
      );
      expect(nodeInfoLink).toBeDefined();
      expect(nodeInfoLink.href).toContain("/nodeinfo/2.0");
    });
  });

  describe("GET /.well-known/host-meta", () => {
    it("returns XML with webfinger template", async () => {
      const app = makeApp(db);
      const res = await app.request("http://localhost:3000/.well-known/host-meta");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/xrd+xml");

      const text = await res.text();
      expect(text).toContain("<?xml");
      expect(text).toContain("webfinger");
      expect(text).toContain("{uri}");
    });

    it("escapes XML special characters in base URL", async () => {
      const app = makeApp(db);
      const res = await app.request("http://localhost:3000/.well-known/host-meta");
      const text = await res.text();
      expect(text).not.toContain("<script>");
    });
  });

  describe("GET /nodeinfo/2.0", () => {
    it("returns nodeinfo document with correct structure", async () => {
      const app = makeApp(db);
      const res = await app.request("http://localhost:3000/nodeinfo/2.0");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.version).toBe("2.0");
      expect(body.software).toBeDefined();
      expect(body.software.name).toBe("everycal");
      expect(body.protocols).toContain("activitypub");
      expect(body.usage).toBeDefined();
      expect(body.usage.users).toBeDefined();
      expect(typeof body.usage.users.total).toBe("number");
      expect(typeof body.usage.localPosts).toBe("number");
    });

    it("returns correct user count", async () => {
      db.prepare("INSERT INTO accounts (id, username) VALUES (?, ?)").run("u1", "alice");
      db.prepare("INSERT INTO accounts (id, username) VALUES (?, ?)").run("u2", "bob");
      const app = makeApp(db);

      const res = await app.request("http://localhost:3000/nodeinfo/2.0");
      const body = await res.json();
      expect(body.usage.users.total).toBe(2);
    });

    it("returns correct public event count", async () => {
      db.prepare(
        "INSERT INTO accounts (id, username) VALUES (?, ?)"
      ).run("u1", "alice");
      db.prepare(
        "INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, visibility, all_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run("e1", "u1", "ev1", "Public Event", "2026-01-01", "2026-01-01T00:00:00Z", "UTC", "public", 1);
      db.prepare(
        "INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, visibility, all_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run("e2", "u1", "ev2", "Private Event", "2026-01-01", "2026-01-01T00:00:00Z", "UTC", "private", 1);
      const app = makeApp(db);

      const res = await app.request("http://localhost:3000/nodeinfo/2.0");
      const body = await res.json();
      expect(body.usage.localPosts).toBe(1);
    });
  });
});
