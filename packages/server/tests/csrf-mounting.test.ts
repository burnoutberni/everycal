/**
 * Regression tests for CSRF middleware mounting on route groups.
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
 *   The inverse concern — that `app.use("/api/v1/events/*", mw)` might
 *   protect subpaths but skip the bare collection path `/api/v1/events`
 *   used by `router.post("/")` in `routes/events/write.ts`,
 *   `routes/identities.ts`, `routes/uploads.ts`, and `routes/locations.ts`
 *   — does not hold for the Hono version pinned here: its `/*` wildcard
 *   matches zero or more segments, so the mount covers both the bare
 *   collection path and every subpath. The bare-collection tests below
 *   pin that semantic so a future Hono upgrade that tightens `/*` to
 *   "one or more segments" can't silently expose the collection POSTs.
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

/**
 * Mirrors the production shape that prompted the bare-collection concern:
 * `app.route("/api/v1/events", eventRoutes(db))` registers `router.post("/")`
 * (POST `/api/v1/events`), and the CSRF middleware is mounted at
 * `/api/v1/events/*`. The same pattern applies to `/api/v1/identities`,
 * `/api/v1/uploads`, and `/api/v1/locations`.
 */
function createCollectionApp(mountPath: string) {
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
  app.post("/api/v1/events", (c) => c.json({ ok: true, where: "bare-collection" }));
  app.post("/api/v1/events/:id/rsvp", (c) => c.json({ ok: true, where: "subpath" }));
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

describe("CSRF middleware mounting covers bare collection paths", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("rejects a cross-site POST to bare /api/v1/events when mounted as /api/v1/events/*", async () => {
    // The reviewer's concern: `app.use("/api/v1/events/*", requireCsrf(...))`
    // is assumed to skip the bare `/api/v1/events` collection POST registered
    // by `router.post("/")`. In Hono 4.x, `/*` matches zero or more segments,
    // so the middleware does run on the bare path. This test pins that
    // semantic — if it starts failing, the collection POSTs for events,
    // identities, uploads, and locations have lost CSRF coverage and
    // `src/index.ts` needs explicit exact mounts (e.g. `app.use("/api/v1/events", ...)`).
    const app = createCollectionApp("/api/v1/events/*");
    const res = await app.request("http://localhost:3000/api/v1/events", {
      method: "POST",
      headers: {
        origin: EVIL_ORIGIN,
        cookie: "everycal_session=valid-session; everycal_csrf=csrf1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "evil" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "csrf_origin_mismatch" });
  });

  it("rejects a same-origin POST to bare /api/v1/events missing the x-csrf-token header", async () => {
    const app = createCollectionApp("/api/v1/events/*");
    const res = await app.request("http://localhost:3000/api/v1/events", {
      method: "POST",
      headers: {
        origin: APP_ORIGIN,
        cookie: "everycal_session=valid-session; everycal_csrf=csrf1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "no token" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "csrf_token_invalid" });
  });

  it("accepts a same-origin POST to bare /api/v1/events with matching double-submit cookie + header", async () => {
    const app = createCollectionApp("/api/v1/events/*");
    const res = await app.request("http://localhost:3000/api/v1/events", {
      method: "POST",
      headers: {
        origin: APP_ORIGIN,
        cookie: "everycal_session=valid-session; everycal_csrf=csrf-ok",
        "x-csrf-token": "csrf-ok",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "legit" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, where: "bare-collection" });
  });

  it("also rejects a cross-site POST to a subpath /api/v1/events/:id/rsvp under the same mount", async () => {
    // Sanity check: the same `/api/v1/events/*` mount must still cover
    // subpaths. If only the bare path is covered, RSVP and similar
    // nested mutations would be exposed.
    const app = createCollectionApp("/api/v1/events/*");
    const res = await app.request("http://localhost:3000/api/v1/events/abc123/rsvp", {
      method: "POST",
      headers: {
        origin: EVIL_ORIGIN,
        cookie: "everycal_session=valid-session; everycal_csrf=csrf1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "yes" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "csrf_origin_mismatch" });
  });
});
