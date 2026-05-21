import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createApiCorsMiddleware } from "../src/middleware/api-cors.js";

function createApp(allowedOrigins: string[]) {
  const app = new Hono();
  app.use("/api/*", createApiCorsMiddleware(allowedOrigins));
  app.get("/api/v1/admin/test", (c) => c.json({ ok: true }));
  app.get("/api/v1/events/test", (c) => c.json({ ok: true }));
  return app;
}

describe("admin CORS restriction", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBaseUrl = process.env.BASE_URL;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    process.env.BASE_URL = "https://canonical.example.com";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.BASE_URL = originalBaseUrl;
  });

  it("allows requests to admin endpoints from the canonical origin", async () => {
    const app = createApp(["https://external-allowed.com"]);
    const res = await app.request("http://localhost/api/v1/admin/test", {
      headers: { Origin: "https://canonical.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://canonical.example.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("denies requests to admin endpoints from non-canonical origins, even if in general allowlist", async () => {
    const app = createApp(["https://external-allowed.com"]);
    const res = await app.request("http://localhost/api/v1/admin/test", {
      headers: { Origin: "https://external-allowed.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows general api routes to use the general allowed origins", async () => {
    const app = createApp(["https://external-allowed.com"]);
    const res = await app.request("http://localhost/api/v1/events/test", {
      headers: { Origin: "https://external-allowed.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://external-allowed.com");
  });

  it("allows http://localhost:5173 for admin endpoints in development mode", async () => {
    process.env.NODE_ENV = "development";
    const app = createApp(["https://external-allowed.com"]);
    const res = await app.request("http://localhost/api/v1/admin/test", {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("denies http://localhost:5173 for admin endpoints in production mode", async () => {
    process.env.NODE_ENV = "production";
    const app = createApp(["https://external-allowed.com"]);
    const res = await app.request("http://localhost/api/v1/admin/test", {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
