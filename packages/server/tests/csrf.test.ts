import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { requireCsrf } from "../src/middleware/csrf.js";

const APP_ORIGIN = "http://localhost:3000";
const DEV_ORIGIN = "http://localhost:5173";
const EVIL_ORIGIN = "http://evil.example.com";

function createApp(allowedOrigins: Set<string> = new Set([APP_ORIGIN, DEV_ORIGIN])) {
  const app = new Hono();
  app.use("*", requireCsrf(allowedOrigins));
  app.post("/mutate", (c) => c.json({ ok: true }));
  app.put("/mutate", (c) => c.json({ ok: true }));
  app.patch("/mutate", (c) => c.json({ ok: true }));
  app.delete("/mutate", (c) => c.json({ ok: true }));
  app.get("/safe", (c) => c.json({ ok: true }));
  return app;
}

function sessionCookie(token: string) {
  return `everycal_session=${token}`;
}

function fullCookie(session: string, csrf: string) {
  return `everycal_session=${session}; everycal_csrf=${csrf}`;
}

describe("requireCsrf middleware", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  // --- Safe methods pass through ---

  it("allows GET without CSRF", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/safe", {
      headers: { cookie: sessionCookie("tok") },
    });
    expect(res.status).toBe(200);
  });

  it("allows HEAD without CSRF", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/safe", { method: "HEAD" });
    expect(res.status).toBe(200);
  });

  it("allows OPTIONS without CSRF", async () => {
    const app = createApp();
    // Hono returns 404 for OPTIONS on a GET-only route, but the middleware
    // still passes through (no CSRF rejection). Verify with a catch-all.
    const testApp = new Hono();
    testApp.use("*", requireCsrf(new Set([APP_ORIGIN])));
    testApp.on("OPTIONS", "/safe", (c) => c.text(""));
    const res = await testApp.request("http://localhost:3000/safe", { method: "OPTIONS" });
    expect(res.status).toBe(200);
  });

  // --- Non-cookie auth bypasses CSRF ---

  it("allows Bearer token without CSRF", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "POST",
      headers: { authorization: "Bearer some-session-token" },
    });
    expect(res.status).toBe(200);
  });

  it("allows ApiKey without CSRF", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "POST",
      headers: { authorization: "ApiKey ecal_abcdef1234567890" },
    });
    expect(res.status).toBe(200);
  });

  // --- No session cookie bypasses CSRF ---

  it("allows POST without session cookie (unauthenticated)", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "POST",
    });
    expect(res.status).toBe(200);
  });

  // --- Origin configuration ---

  it("rejects when allowed origins set is empty", async () => {
    const app = createApp(new Set());
    const res = await app.request("http://localhost:3000/mutate", {
      method: "POST",
      headers: {
        cookie: fullCookie("sess", "csrf123"),
        "x-csrf-token": "csrf123",
        origin: APP_ORIGIN,
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("csrf_origin_unconfigured");
  });

  // --- Origin / Referer validation ---

  it("rejects when origin header does not match allowed origins", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "POST",
      headers: {
        cookie: fullCookie("sess", "csrf123"),
        "x-csrf-token": "csrf123",
        origin: EVIL_ORIGIN,
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("csrf_origin_mismatch");
  });

  it("rejects when referer origin does not match allowed origins", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "POST",
      headers: {
        cookie: fullCookie("sess", "csrf123"),
        "x-csrf-token": "csrf123",
        referer: `${EVIL_ORIGIN}/path`,
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("csrf_origin_mismatch");
  });

  it("passes when origin matches an allowed origin", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "POST",
      headers: {
        cookie: fullCookie("sess", "csrf123"),
        "x-csrf-token": "csrf123",
        origin: APP_ORIGIN,
      },
    });
    expect(res.status).toBe(200);
  });

  it("passes when referer matches an allowed origin", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "POST",
      headers: {
        cookie: fullCookie("sess", "csrf123"),
        "x-csrf-token": "csrf123",
        referer: `${APP_ORIGIN}/events/123`,
      },
    });
    expect(res.status).toBe(200);
  });

  it("passes when neither origin nor referer is present", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "POST",
      headers: {
        cookie: fullCookie("sess", "csrf123"),
        "x-csrf-token": "csrf123",
      },
    });
    expect(res.status).toBe(200);
  });

  // --- Double-submit cookie validation ---

  it("rejects when x-csrf-token header is missing", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "POST",
      headers: {
        cookie: fullCookie("sess", "csrf123"),
        origin: APP_ORIGIN,
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("csrf_token_invalid");
  });

  it("rejects when everycal_csrf cookie is missing", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "POST",
      headers: {
        cookie: sessionCookie("sess"),
        "x-csrf-token": "csrf123",
        origin: APP_ORIGIN,
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("csrf_token_invalid");
  });

  it("rejects when cookie and header csrf values do not match", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "POST",
      headers: {
        cookie: fullCookie("sess", "token-A"),
        "x-csrf-token": "token-B",
        origin: APP_ORIGIN,
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("csrf_token_invalid");
  });

  it("passes with matching double-submit cookie and header", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "POST",
      headers: {
        cookie: fullCookie("sess", "csrf-ok-123"),
        "x-csrf-token": "csrf-ok-123",
        origin: APP_ORIGIN,
      },
    });
    expect(res.status).toBe(200);
  });

  // --- All unsafe methods ---

  it("enforces CSRF on PUT", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "PUT",
      headers: {
        cookie: fullCookie("sess", "csrf123"),
        "x-csrf-token": "csrf123",
        origin: APP_ORIGIN,
      },
    });
    expect(res.status).toBe(200);
  });

  it("enforces CSRF on PATCH", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "PATCH",
      headers: {
        cookie: fullCookie("sess", "csrf123"),
        "x-csrf-token": "csrf123",
        origin: APP_ORIGIN,
      },
    });
    expect(res.status).toBe(200);
  });

  it("enforces CSRF on DELETE", async () => {
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "DELETE",
      headers: {
        cookie: fullCookie("sess", "csrf123"),
        "x-csrf-token": "csrf123",
        origin: APP_ORIGIN,
      },
    });
    expect(res.status).toBe(200);
  });

  // --- Dev origin support ---

  it("allows dev origin when NODE_ENV is not production", async () => {
    process.env.NODE_ENV = "development";
    const app = createApp();
    const res = await app.request("http://localhost:3000/mutate", {
      method: "POST",
      headers: {
        cookie: fullCookie("sess", "csrf123"),
        "x-csrf-token": "csrf123",
        origin: DEV_ORIGIN,
      },
    });
    expect(res.status).toBe(200);
  });
});
