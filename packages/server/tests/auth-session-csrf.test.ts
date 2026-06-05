import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase } from "../src/db.js";
import { resolveBootstrap } from "../src/lib/bootstrap.js";
import { authMiddleware, createSession, hashPassword } from "../src/middleware/auth.js";
import { getAllowedAdminOrigins } from "../src/middleware/admin-origins.js";
import { requireCsrf } from "../src/middleware/csrf.js";
import { adminRoutes } from "../src/routes/admin.js";
import { authRoutes } from "../src/routes/auth.js";
import { maybeSetMissingCsrfCookie } from "../src/routes/auth/session-cookies.js";

function createApp() {
  const db = initDatabase(":memory:");
  const app = new Hono();
  app.use("*", authMiddleware(db));
  app.use("/api/v1/auth/*", requireCsrf(getAllowedAdminOrigins(db)));
  app.get("/api/v1/bootstrap", (c) => {
    maybeSetMissingCsrfCookie(c, c.req.header("cookie"), c.get("cookieSessionExpiresAt"));
    return c.json(resolveBootstrap(c, db));
  });
  app.route("/api/v1/auth", authRoutes(db));
  app.route("/api/v1/admin", adminRoutes(db));
  return { app, db };
}

function extractCsrfCookie(setCookieHeader: string | null): string | null {
  const match = setCookieHeader?.match(/everycal_csrf=([^;]+)/);
  return match?.[1] ?? null;
}

describe("legacy session CSRF minting", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBaseUrl = process.env.BASE_URL;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    process.env.BASE_URL = "http://localhost:3000";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.BASE_URL = originalBaseUrl;
  });

  it("mints a CSRF cookie during bootstrap for a legacy cookie session and unblocks admin mutations", async () => {
    const { app, db } = createApp();
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1', 'admin', 1)").run();

    const session = createSession(db, "a1");
    const bootstrap = await app.request("http://localhost:3000/api/v1/bootstrap", {
      headers: {
        cookie: `everycal_session=${session.token}`,
      },
    });

    expect(bootstrap.status).toBe(200);
    const csrfToken = extractCsrfCookie(bootstrap.headers.get("set-cookie"));
    expect(csrfToken).toBeTruthy();

    const mutation = await app.request("http://localhost:3000/api/v1/admin/federation/block", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        cookie: `everycal_session=${session.token}; everycal_csrf=${csrfToken}`,
        "x-csrf-token": csrfToken!,
        "content-type": "application/json",
      },
      body: JSON.stringify({ blockType: "domain", domain: "legacy-session.test", reason: "regression coverage" }),
    });

    expect(mutation.status).toBe(200);
  });

  it("mints a CSRF cookie during authenticated auth/me refresh for a legacy cookie session", async () => {
    const { app, db } = createApp();
    db.prepare("INSERT INTO accounts (id, username, is_admin) VALUES ('a1', 'admin', 1)").run();

    const session = createSession(db, "a1");
    const res = await app.request("http://localhost:3000/api/v1/auth/me", {
      headers: {
        cookie: `everycal_session=${session.token}`,
      },
    });

    expect(res.status).toBe(200);
    expect(extractCsrfCookie(res.headers.get("set-cookie"))).toBeTruthy();
  });

  it("allows login with a stale session cookie and no CSRF token", async () => {
    const { app, db } = createApp();
    db.prepare(
      "INSERT INTO accounts (id, username, password_hash, email_verified, is_admin) VALUES (?, ?, ?, 1, 0)"
    ).run("a1", "admin", hashPassword("password123"));

    const res = await app.request("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: {
        cookie: "everycal_session=stale-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ username: "admin", password: "password123" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("everycal_session=");
  });
});
