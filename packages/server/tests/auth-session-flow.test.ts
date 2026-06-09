import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { authRoutes } from "../src/routes/auth.js";
import { authMiddleware, createSession, hashPassword } from "../src/middleware/auth.js";

function makeApp(db: DB) {
  const app = new Hono();
  app.use("*", authMiddleware(db));
  app.route("/api/v1/auth", authRoutes(db));
  app.get("/api/v1/auth/me", (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    return c.json({ id: user.id, username: user.username, isAdmin: user.isAdmin });
  });
  return app;
}

describe("auth login / logout / lockout flows", () => {
  let db: DB;

  beforeEach(() => {
    process.env.OPEN_REGISTRATIONS = "true";
    process.env.NODE_ENV = "production";
    process.env.BASE_URL = "http://localhost:3000";
    db = initDatabase(":memory:");
  });

  function seedUser(username = "alice", password = "secure-password-123") {
    db.prepare(
      "INSERT INTO accounts (id, username, password_hash, email, email_verified) VALUES (?, ?, ?, ?, ?)"
    ).run("u1", username, hashPassword(password), `${username}@example.com`, 1);
    db.prepare(
      `INSERT INTO account_notification_prefs (account_id, reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled) VALUES (?, 1, 24, 1, 1)`
    ).run("u1");
    return { id: "u1", username, password };
  }

  describe("login", () => {
    it("returns a session cookie on successful login", async () => {
      const user = seedUser();
      const app = makeApp(db);
      const res = await app.request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: user.username, password: user.password }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user).toBeDefined();
      expect(body.user.username).toBe(user.username);
      expect(body.expiresAt).toBeDefined();

      const sessionRow = db.prepare("SELECT auth_method FROM sessions WHERE account_id = ?").get(user.id) as { auth_method: string };
      expect(sessionRow.auth_method).toBe("local");

      const setCookie = res.headers.get("set-cookie") || "";
      expect(setCookie).toContain("everycal_session=");
    });

    it("returns 401 for wrong password", async () => {
      const user = seedUser();
      const app = makeApp(db);
      const res = await app.request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: user.username, password: "wrong-password" }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it("returns 400 when username or password is missing", async () => {
      const app = makeApp(db);
      const res = await app.request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "alice" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 403 when email is not verified", async () => {
      db.prepare(
        "INSERT INTO accounts (id, username, password_hash, email, email_verified) VALUES (?, ?, ?, ?, ?)"
      ).run("u_unverified", "unverified", hashPassword("pw"), "unverified@example.com", 0);
      db.prepare(
        `INSERT INTO account_notification_prefs (account_id, reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled) VALUES (?, 1, 24, 1, 1)`
      ).run("u_unverified");

      const app = makeApp(db);
      const res = await app.request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "unverified", password: "pw" }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });

  describe("logout", () => {
    it("clears the session cookie", async () => {
      const user = seedUser();
      const session = createSession(db, user.id);
      const app = makeApp(db);

      const res = await app.request("http://localhost/api/v1/auth/logout", {
        method: "POST",
        headers: {
          cookie: `everycal_session=${session.token}`,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      const setCookie = res.headers.get("set-cookie") || "";
      expect(setCookie).toContain("everycal_session=;");
    });

    it("session is invalid after logout", async () => {
      const user = seedUser();
      const session = createSession(db, user.id);
      const app = makeApp(db);

      // Logout
      await app.request("http://localhost/api/v1/auth/logout", {
        method: "POST",
        headers: { cookie: `everycal_session=${session.token}` },
      });

      // Try to use the old session
      const me = await app.request("http://localhost/api/v1/auth/me", {
        headers: { cookie: `everycal_session=${session.token}` },
      });
      expect(me.status).toBe(401);
    });
  });

  describe("lockout", () => {
    it("locks account after 10 failed attempts", async () => {
      const user = seedUser();
      const app = makeApp(db);

      // Make 10 failed attempts
      for (let i = 0; i < 10; i++) {
        await app.request("http://localhost/api/v1/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: user.username, password: "wrong" }),
        });
      }

      // 11th attempt should be locked
      const res = await app.request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: user.username, password: user.password }),
      });

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it("successful login clears failed attempts", async () => {
      const user = seedUser();
      const app = makeApp(db);

      // Make 5 failed attempts
      for (let i = 0; i < 5; i++) {
        await app.request("http://localhost/api/v1/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: user.username, password: "wrong" }),
        });
      }

      // Successful login
      const res = await app.request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: user.username, password: user.password }),
      });
      expect(res.status).toBe(200);

      // 5 more failed attempts should NOT lock (counter was reset)
      for (let i = 0; i < 5; i++) {
        await app.request("http://localhost/api/v1/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: user.username, password: "wrong" }),
        });
      }

      // Should still be able to login
      const final = await app.request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: user.username, password: user.password }),
      });
      expect(final.status).toBe(200);
    });
  });

  describe("GET /me", () => {
    it("returns current user when authenticated via cookie", async () => {
      const user = seedUser();
      const session = createSession(db, user.id);
      const app = makeApp(db);

      const res = await app.request("http://localhost/api/v1/auth/me", {
        headers: { cookie: `everycal_session=${session.token}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(user.id);
      expect(body.username).toBe(user.username);
    });

    it("returns 401 when not authenticated", async () => {
      const app = makeApp(db);
      const res = await app.request("http://localhost/api/v1/auth/me");
      expect(res.status).toBe(401);
    });
  });

  describe("notification prefs", () => {
    it("rejects onboarding completion when the stored city is blank", async () => {
      const user = seedUser();
      db.prepare("UPDATE accounts SET city = ?, city_lat = ?, city_lng = ? WHERE id = ?").run("   ", 48.2, 16.37, user.id);
      const session = createSession(db, user.id);
      const app = makeApp(db);

      const res = await app.request("http://localhost/api/v1/auth/notification-prefs", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: `everycal_session=${session.token}`,
        },
        body: JSON.stringify({ onboardingCompleted: true }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "auth.city_required" });
    });

    it("rejects unrelated notification updates when onboarding is already complete without location", async () => {
      const user = seedUser();
      db.prepare("UPDATE accounts SET city = ?, city_lat = ?, city_lng = ? WHERE id = ?").run(null, null, null, user.id);
      db.prepare("UPDATE account_notification_prefs SET onboarding_completed = 1 WHERE account_id = ?").run(user.id);
      const session = createSession(db, user.id);
      const app = makeApp(db);

      const res = await app.request("http://localhost/api/v1/auth/notification-prefs", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: `everycal_session=${session.token}`,
        },
        body: JSON.stringify({ reminderEnabled: false }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "auth.city_required" });
    });
  });

  describe("registration", () => {
    it("sends verification email for human registration", async () => {
      const app = makeApp(db);
      const res = await app.request("http://localhost/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "newuser",
          email: "newuser@example.com",
          password: "secure-password-123",
          city: "Vienna",
          cityLat: 48.2,
          cityLng: 16.37,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.requiresVerification).toBe(true);
    });

    it("rejects duplicate username", async () => {
      seedUser("taken");
      const app = makeApp(db);
      const res = await app.request("http://localhost/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "taken",
          email: "other@example.com",
          password: "secure-password-123",
          city: "Vienna",
          cityLat: 48.2,
          cityLng: 16.37,
        }),
      });

      expect(res.status).toBe(409);
    });

    it("rejects registration when open_registrations is disabled", async () => {
      process.env.OPEN_REGISTRATIONS = "false";
      const app = makeApp(db);
      const res = await app.request("http://localhost/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "newuser",
          email: "newuser@example.com",
          password: "secure-password-123",
          city: "Vienna",
          cityLat: 48.2,
          cityLng: 16.37,
        }),
      });

      expect(res.status).toBe(403);
    });

    it("rejects blank city names even when coordinates are present", async () => {
      const app = makeApp(db);
      const res = await app.request("http://localhost/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "blankcity",
          email: "blankcity@example.com",
          password: "secure-password-123",
          city: "   ",
          cityLat: 48.2,
          cityLng: 16.37,
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "auth.city_required" });
    });
  });
});
