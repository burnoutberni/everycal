import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { rateLimiter } from "../src/middleware/rate-limit.js";

function createApp(opts: { windowMs: number; max: number; trustedProxy?: boolean }) {
  const app = new Hono();
  app.use("*", rateLimiter(opts));
  app.get("/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("rateLimiter middleware", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests within the limit", async () => {
    const app = createApp({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i++) {
      const res = await app.request("http://localhost/ping");
      expect(res.status).toBe(200);
    }
  });

  it("returns 429 when limit is exceeded", async () => {
    const app = createApp({ windowMs: 60_000, max: 2 });
    await app.request("http://localhost/ping");
    await app.request("http://localhost/ping");
    const res = await app.request("http://localhost/ping");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("sets X-RateLimit-Limit header", async () => {
    const app = createApp({ windowMs: 60_000, max: 10 });
    const res = await app.request("http://localhost/ping");
    expect(res.headers.get("x-ratelimit-limit")).toBe("10");
  });

  it("sets X-RateLimit-Remaining header", async () => {
    const app = createApp({ windowMs: 60_000, max: 5 });
    const res = await app.request("http://localhost/ping");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("4");
  });

  it("decrements remaining on each request", async () => {
    const app = createApp({ windowMs: 60_000, max: 5 });
    const res1 = await app.request("http://localhost/ping");
    expect(Number(res1.headers.get("x-ratelimit-remaining"))).toBe(4);
    const res2 = await app.request("http://localhost/ping");
    expect(Number(res2.headers.get("x-ratelimit-remaining"))).toBe(3);
  });

  it("sets X-RateLimit-Reset header as unix seconds", async () => {
    const app = createApp({ windowMs: 60_000, max: 10 });
    const res = await app.request("http://localhost/ping");
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    expect(reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("resets the counter after the window expires", async () => {
    const app = createApp({ windowMs: 10_000, max: 1 });
    await app.request("http://localhost/ping");
    const blocked = await app.request("http://localhost/ping");
    expect(blocked.status).toBe(429);

    vi.advanceTimersByTime(10_001);
    const afterReset = await app.request("http://localhost/ping");
    expect(afterReset.status).toBe(200);
  });

  it("respects X-Forwarded-For when trustedProxy is true", async () => {
    const app = createApp({ windowMs: 60_000, max: 1, trustedProxy: true });
    await app.request("http://localhost/ping", {
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    const res = await app.request("http://localhost/ping", {
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    expect(res.status).toBe(429);
  });

  it("isolates different X-Forwarded-For IPs when trustedProxy is true", async () => {
    const app = createApp({ windowMs: 60_000, max: 1, trustedProxy: true });
    await app.request("http://localhost/ping", {
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    // Different IP should have its own counter
    const res = await app.request("http://localhost/ping", {
      headers: { "x-forwarded-for": "10.0.0.2" },
    });
    expect(res.status).toBe(200);
  });

  it("uses first IP from comma-separated X-Forwarded-For", async () => {
    const app = createApp({ windowMs: 60_000, max: 1, trustedProxy: true });
    await app.request("http://localhost/ping", {
      headers: { "x-forwarded-for": "10.0.0.1, 10.0.0.2" },
    });
    const res = await app.request("http://localhost/ping", {
      headers: { "x-forwarded-for": "10.0.0.1, 10.0.0.3" },
    });
    expect(res.status).toBe(429);
  });
});
