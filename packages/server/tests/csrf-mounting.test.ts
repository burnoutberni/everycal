/**
 * Regression tests for CSRF middleware mounting on route-group subpaths.
 *
 * Background:
 *   Hono's `app.use(prefix, mw)` matches only the exact path. To apply a
 *   middleware to every subpath, the prefix must end in `/*`. Without it,
 *   `app.use("/api/v1/auth", requireCsrf(...))` only attaches to
 *   `/api/v1/auth` itself and leaves every `/api/v1/auth/...` mutation
 *   (e.g. `logout`, `change-password`) without CSRF protection — a
 *   cross-site form POST carrying the victim's session cookie would slip
 *   through and trigger those actions.
 *
 * These tests pin the mounting shape used in `src/index.ts` so the bug
 * can't silently regress.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { requireCsrf } from "../src/middleware/csrf.js";

const APP_ORIGIN = "http://localhost:3000";
const EVIL_ORIGIN = "http://evil.example.com";

function createApp(mountPath: string) {
  const app = new Hono();
  app.use(
    "*",
    createMiddleware(async (c, next) => {
      const cookieHeader = c.req.header("cookie") || "";
      c.set(
        "cookieSessionExpiresAt",
        cookieHeader.includes("everycal_session=valid-session") ? "2099-01-01 00:00:00" : null
      );
      await next();
    })
  );
  app.use(mountPath, requireCsrf(new Set([APP_ORIGIN])));
  app.post("/api/v1/auth/logout", (c) => c.json({ ok: true }));
  app.post("/api/v1/auth/change-password", (c) => c.json({ ok: true }));
  return app;
}

describe("CSRF middleware mounting covers route-group subpaths", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("rejects a cross-site POST to /api/v1/auth/logout when mounted as /api/v1/auth/*", async () => {
    const app = createApp("/api/v1/auth/*");
    const res = await app.request("http://localhost:3000/api/v1/auth/logout", {
      method: "POST",
      headers: {
        origin: EVIL_ORIGIN,
        cookie: "everycal_session=valid-session; everycal_csrf=csrf1",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "csrf_origin_mismatch" });
  });

  it("rejects a cross-site POST to /api/v1/auth/change-password when mounted as /api/v1/auth/*", async () => {
    const app = createApp("/api/v1/auth/*");
    const res = await app.request("http://localhost:3000/api/v1/auth/change-password", {
      method: "POST",
      headers: {
        origin: EVIL_ORIGIN,
        cookie: "everycal_session=valid-session; everycal_csrf=csrf1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ currentPassword: "a", newPassword: "b" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "csrf_origin_mismatch" });
  });

  it("rejects a same-origin POST missing the x-csrf-token header on a subpath", async () => {
    const app = createApp("/api/v1/auth/*");
    const res = await app.request("http://localhost:3000/api/v1/auth/logout", {
      method: "POST",
      headers: {
        origin: APP_ORIGIN,
        cookie: "everycal_session=valid-session; everycal_csrf=csrf1",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "csrf_token_invalid" });
  });

  it("accepts a same-origin POST with matching double-submit cookie + header on a subpath", async () => {
    const app = createApp("/api/v1/auth/*");
    const res = await app.request("http://localhost:3000/api/v1/auth/logout", {
      method: "POST",
      headers: {
        origin: APP_ORIGIN,
        cookie: "everycal_session=valid-session; everycal_csrf=csrf-ok",
        "x-csrf-token": "csrf-ok",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  it("does NOT mount CSRF on subpaths when the prefix lacks /* (documents the original bug)", async () => {
    // This test pins the exact failure mode the wildcard fix prevents:
    // `app.use("/api/v1/auth", ...)` matches only `/api/v1/auth`, not
    // `/api/v1/auth/logout`, so a cross-site POST carrying a valid session
    // cookie reaches the handler unimpeded. If this ever starts passing,
    // someone has changed Hono's path semantics — investigate before
    // removing the `/*` wildcards from `src/index.ts`.
    const app = createApp("/api/v1/auth");
    const res = await app.request("http://localhost:3000/api/v1/auth/logout", {
      method: "POST",
      headers: {
        origin: EVIL_ORIGIN,
        cookie: "everycal_session=valid-session; everycal_csrf=csrf1",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });
});
