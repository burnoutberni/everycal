import { describe, expect, it, vi, beforeEach } from "vitest";

const appFetch = vi.fn();
const createUnifiedApp = vi.fn(() => ({ fetch: appFetch }));
const renderWorkerHtml = vi.fn();
const verifyInboxRequest = vi.fn(async () => ({ ok: true }));
const deliverActivity = vi.fn(async () => ({ ok: true }));
const syncRemoteActorAndEvents = vi.fn(async () => ({ actor: null, eventsSynced: 0 }));
const fetchMock = vi.fn();

vi.mock("@everycal/runtime-core", () => ({
  createUnifiedApp,
}));

vi.mock("./ssr", () => ({
  renderWorkerHtml,
}));

vi.mock("./federation", () => ({
  verifyInboxRequest,
  deliverActivity,
  syncRemoteActorAndEvents,
}));

import worker from "./index";

describe("cloudflare worker entry", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    appFetch.mockReset();
    createUnifiedApp.mockClear();
    renderWorkerHtml.mockReset();
    verifyInboxRequest.mockClear();
    deliverActivity.mockClear();
    syncRemoteActorAndEvents.mockClear();
    fetchMock.mockReset();
  });

  it("returns SSR HTML response when available", async () => {
    const expected = new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } });
    renderWorkerHtml.mockResolvedValueOnce(expected);

    const request = new Request("https://calendar.example/", { headers: { accept: "text/html" } });
    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run: vi.fn(async () => ({ success: true })) })) })) },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
    } as unknown as Parameters<typeof worker.fetch>[1];

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(renderWorkerHtml).toHaveBeenCalledWith(request, env);
    expect(createUnifiedApp).not.toHaveBeenCalled();
  });

  it("falls back to unified API app when SSR returns null", async () => {
    renderWorkerHtml.mockResolvedValueOnce(null);
    const fallback = new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    appFetch.mockResolvedValueOnce(fallback);

    const request = new Request("https://calendar.example/api/v1/bootstrap", { headers: { accept: "application/json" } });
    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run: vi.fn(async () => ({ success: true })) })) })) },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
      SESSION_COOKIE_NAME: "everycal_session",
    } as unknown as Parameters<typeof worker.fetch>[1];

    const ctx = {} as ExecutionContext;
    const response = await worker.fetch(request, env, ctx);

    expect(renderWorkerHtml).toHaveBeenCalledWith(request, env);
    expect(createUnifiedApp).toHaveBeenCalledTimes(1);
    expect(appFetch).toHaveBeenCalledWith(request, env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("returns deploy-readiness success when required Cloudflare runtime wiring is present", async () => {
    const request = new Request("https://calendar.example/api/v1/system/deploy-readiness");
    const env = {
      BASE_URL: "https://calendar.example",
      CORS_ORIGIN: "https://app.example",
      ACTIVITYPUB_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
      JOBS_QUEUE: { send: vi.fn() },
      REMINDERS_WEBHOOK_URL: "https://jobs.example/reminders",
      SCRAPERS_WEBHOOK_URL: "https://jobs.example/scrapers",
    } as unknown as Parameters<typeof worker.fetch>[1];

    const response = await worker.fetch(request, env, {} as ExecutionContext);
    const payload = await response.json() as { ok: boolean; summary: { failing: number }; checks: Array<{ id: string; ok: boolean }> };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.summary.failing).toBe(0);
    expect(payload.checks.every((check) => check.ok)).toBe(true);
    expect(renderWorkerHtml).not.toHaveBeenCalled();
    expect(createUnifiedApp).not.toHaveBeenCalled();
  });


  it("deploy-readiness fails when configured service binding healthcheck fails", async () => {
    const request = new Request("https://calendar.example/api/v1/system/deploy-readiness");
    const env = {
      BASE_URL: "https://calendar.example",
      CORS_ORIGIN: "https://app.example",
      ACTIVITYPUB_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
      JOBS_QUEUE: { send: vi.fn() },
      REMINDERS_SERVICE: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 200, headers: { "content-type": "application/json" } })) },
      SCRAPERS_WEBHOOK_URL: "https://jobs.example/scrapers",
    } as unknown as Parameters<typeof worker.fetch>[1];

    const response = await worker.fetch(request, env, {} as ExecutionContext);
    const payload = await response.json() as { ok: boolean; checks: Array<{ id: string; ok: boolean }> };

    expect(response.status).toBe(503);
    expect(payload.ok).toBe(false);
    expect(payload.checks.find((check) => check.id === "reminders_executor_behavior")?.ok).toBe(false);
  });
  it("returns deploy-readiness failure when required wiring is missing", async () => {
    const request = new Request("https://calendar.example/api/v1/system/deploy-readiness");
    const env = {
      BASE_URL: "https://example.workers.dev",
      CORS_ORIGIN: "https://example.pages.dev",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
    } as unknown as Parameters<typeof worker.fetch>[1];

    const response = await worker.fetch(request, env, {} as ExecutionContext);
    const payload = await response.json() as { ok: boolean; summary: { failing: number }; checks: Array<{ id: string; ok: boolean }> };

    expect(response.status).toBe(503);
    expect(payload.ok).toBe(false);
    expect(payload.summary.failing).toBeGreaterThan(0);
    expect(payload.checks.some((check) => !check.ok)).toBe(true);
    expect(renderWorkerHtml).not.toHaveBeenCalled();
    expect(createUnifiedApp).not.toHaveBeenCalled();
  });



  it("handles API CORS preflight for allowed origins", async () => {
    const request = new Request("https://calendar.example/api/v1/bootstrap", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization",
      },
    });
    const env = {
      BASE_URL: "https://calendar.example",
      CORS_ORIGIN: "https://app.example",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
    } as unknown as Parameters<typeof worker.fetch>[1];

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(createUnifiedApp).not.toHaveBeenCalled();
  });

  it("adds CORS response headers on API responses", async () => {
    renderWorkerHtml.mockResolvedValueOnce(null);
    appFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const request = new Request("https://calendar.example/api/v1/bootstrap", {
      headers: { origin: "https://app.example" },
    });
    const env = {
      BASE_URL: "https://calendar.example",
      CORS_ORIGIN: "https://app.example",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
    } as unknown as Parameters<typeof worker.fetch>[1];

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("rejects oversized non-upload request bodies", async () => {
    const request = new Request("https://calendar.example/api/v1/events", {
      method: "POST",
      headers: { "content-length": String(1024 * 1024 + 1) },
      body: "x",
    });
    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
    } as unknown as Parameters<typeof worker.fetch>[1];

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request_body_too_large" });
    expect(createUnifiedApp).not.toHaveBeenCalled();
  });



  it("adds rate-limit headers on limited routes", async () => {
    renderWorkerHtml.mockResolvedValueOnce(null);
    appFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const request = new Request("https://calendar.example/api/v1/auth/login", {
      headers: { "cf-connecting-ip": "198.51.100.10" },
    });
    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
    } as unknown as Parameters<typeof worker.fetch>[1];

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-limit")).toBe("10");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("9");
    expect(response.headers.get("x-ratelimit-reset")).toBeTruthy();
    expect(response.headers.get("x-ratelimit-scope")).toBe("local");
  });



  it("uses global rate limits when KV binding is configured", async () => {
    renderWorkerHtml.mockResolvedValue(null);
    appFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const kv = {
      get: vi.fn(async () => "10"),
      put: vi.fn(async () => undefined),
    };

    const request = new Request("https://calendar.example/api/v1/auth/login", {
      headers: { "cf-connecting-ip": "198.51.100.12" },
    });
    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
      RATE_LIMITS_KV: kv,
    } as unknown as Parameters<typeof worker.fetch>[1];

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "too_many_requests" });
    expect(response.headers.get("x-ratelimit-scope")).toBe("global_kv");
    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledTimes(1);
  });



  it("prefers durable-object global rate limits when configured", async () => {
    renderWorkerHtml.mockResolvedValue(null);
    appFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const doFetch = vi.fn(async () => new Response(JSON.stringify({ count: 11, resetAt: Date.now() + 60_000 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const durable = {
      idFromName: vi.fn(() => ({}) as never),
      get: vi.fn(() => ({ fetch: doFetch })),
    };

    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
      RATE_LIMITS_DO: durable,
      RATE_LIMITS_KV: { get: vi.fn(async () => "0"), put: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof worker.fetch>[1];

    const request = new Request("https://calendar.example/api/v1/auth/login", {
      headers: { "cf-connecting-ip": "198.51.100.14" },
    });
    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(429);
    expect(response.headers.get("x-ratelimit-scope")).toBe("global_do");
    expect(durable.idFromName).toHaveBeenCalledTimes(1);
    expect(durable.get).toHaveBeenCalledTimes(1);
  });

  it("returns 429 when route-level limit is exceeded", async () => {
    renderWorkerHtml.mockResolvedValue(null);
    appFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
    } as unknown as Parameters<typeof worker.fetch>[1];

    let finalResponse: Response | null = null;
    for (let i = 0; i < 11; i += 1) {
      const request = new Request("https://calendar.example/api/v1/auth/login", {
        headers: { "cf-connecting-ip": "198.51.100.11" },
      });
      finalResponse = await worker.fetch(request, env, {} as ExecutionContext);
    }

    expect(finalResponse?.status).toBe(429);
    expect(await finalResponse?.json()).toEqual({ error: "too_many_requests" });
    expect(finalResponse?.headers.get("x-ratelimit-limit")).toBe("10");
    expect(finalResponse?.headers.get("x-ratelimit-remaining")).toBe("0");
  });



  it.each([
    { path: "/api/v1/bootstrap", status: 200, body: { mode: "unified", authenticated: false } },
    { path: "/api/v1/events", status: 401, body: { error: "unauthorized" } },
    { path: "/api/v1/auth/me", status: 401, body: { error: "unauthorized" } },
  ])("preserves runtime-core contract for %s", async ({ path, status, body }) => {
    renderWorkerHtml.mockResolvedValueOnce(null);
    appFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

    const request = new Request(`https://calendar.example${path}`);
    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
    } as unknown as Parameters<typeof worker.fetch>[1];

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("scheduled cleanup also enqueues reminder and scraper jobs", async () => {
    const run = vi.fn(async () => ({ success: true }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const send = vi.fn(async () => undefined);
    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
      JOBS_QUEUE: { send },
    } as unknown as Parameters<typeof worker.scheduled>[1];

    await worker.scheduled({} as ScheduledController, env);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "reminders", attempts: 0, jobId: expect.any(String) }));
    expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: "scrapers", attempts: 0, jobId: expect.any(String) }));
  });

  it("queue handler executes webhook jobs, retries failures, and acks unknown jobs", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));

    const ackKnown = vi.fn();
    const retryKnown = vi.fn();
    const ackUnknown = vi.fn();

    const batch = {
      messages: [
        { body: { type: "reminders", attempts: 0 }, ack: ackKnown, retry: retryKnown },
        { body: { type: "other" }, ack: ackUnknown },
      ],
    } as unknown as Parameters<typeof worker.queue>[0];

    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
      REMINDERS_WEBHOOK_URL: "https://jobs.example/reminders",
      JOBS_WEBHOOK_TOKEN: "token-123",
    } as unknown as Parameters<typeof worker.queue>[1];

    await worker.queue(batch, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(retryKnown).toHaveBeenCalledTimes(1);
    expect(retryKnown).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(ackKnown).not.toHaveBeenCalled();
    expect(ackUnknown).toHaveBeenCalledTimes(1);
  });



  it("queue handler prefers native service bindings over webhooks", async () => {
    const ackKnown = vi.fn();
    const retryKnown = vi.fn();
    const nativeFetch = vi.fn(async () => new Response(null, { status: 200 }));

    const batch = {
      messages: [{ body: { type: "reminders", attempts: 0 }, ack: ackKnown, retry: retryKnown }],
    } as unknown as Parameters<typeof worker.queue>[0];

    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
      REMINDERS_SERVICE: { fetch: nativeFetch },
      REMINDERS_WEBHOOK_URL: "https://jobs.example/reminders",
    } as unknown as Parameters<typeof worker.queue>[1];

    await worker.queue(batch, env);

    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ackKnown).toHaveBeenCalledTimes(1);
    expect(retryKnown).not.toHaveBeenCalled();
  });

  it("queue handler retries on native service failures", async () => {
    const ackKnown = vi.fn();
    const retryKnown = vi.fn();
    const nativeFetch = vi.fn(async () => new Response(null, { status: 503 }));

    const batch = {
      messages: [{ body: { type: "scrapers", attempts: 0 }, ack: ackKnown, retry: retryKnown }],
    } as unknown as Parameters<typeof worker.queue>[0];

    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
      SCRAPERS_SERVICE: { fetch: nativeFetch },
    } as unknown as Parameters<typeof worker.queue>[1];

    await worker.queue(batch, env);

    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(retryKnown).toHaveBeenCalledTimes(1);
    expect(ackKnown).not.toHaveBeenCalled();
  });



  it("queue handler forwards attempt metadata to webhook payload", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const batch = {
      messages: [{ body: { type: "reminders", attempts: 1, jobId: "job-123", enqueuedAt: "2030-01-01T00:00:00.000Z" }, ack: vi.fn(), retry: vi.fn() }],
    } as unknown as Parameters<typeof worker.queue>[0];

    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
      REMINDERS_WEBHOOK_URL: "https://jobs.example/reminders",
    } as unknown as Parameters<typeof worker.queue>[1];

    await worker.queue(batch, env);

    const req = fetchMock.mock.calls[0];
    const payload = JSON.parse(String(req[1]?.body || "{}"));
    expect(payload).toEqual(expect.objectContaining({ attempts: 2, jobId: "job-123", enqueuedAt: "2030-01-01T00:00:00.000Z" }));
  });

  it("uses delivery attempt metadata for retry cap", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));

    const ackKnown = vi.fn();
    const retryKnown = vi.fn();
    const dlqSend = vi.fn(async () => undefined);

    const batch = {
      messages: [{ body: { type: "reminders", attempts: 0 }, attempts: 3, ack: ackKnown, retry: retryKnown }],
    } as unknown as Parameters<typeof worker.queue>[0];

    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
      REMINDERS_WEBHOOK_URL: "https://jobs.example/reminders",
      JOBS_DLQ: { send: dlqSend },
    } as unknown as Parameters<typeof worker.queue>[1];

    await worker.queue(batch, env);

    expect(dlqSend).toHaveBeenCalledTimes(1);
    expect(retryKnown).not.toHaveBeenCalled();
    expect(ackKnown).toHaveBeenCalledTimes(1);
  });

  it("queue handler acks successful known jobs", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const ackScraper = vi.fn();
    const retryScraper = vi.fn();

    const batch = {
      messages: [{ body: { type: "scrapers" }, ack: ackScraper, retry: retryScraper }],
    } as unknown as Parameters<typeof worker.queue>[0];

    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
      SCRAPERS_WEBHOOK_URL: "https://jobs.example/scrapers",
    } as unknown as Parameters<typeof worker.queue>[1];

    await worker.queue(batch, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ackScraper).toHaveBeenCalledTimes(1);
    expect(retryScraper).not.toHaveBeenCalled();
  });


  it("sends exhausted jobs to dead-letter queue and acks", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

    const ackKnown = vi.fn();
    const retryKnown = vi.fn();
    const dlqSend = vi.fn(async () => undefined);

    const batch = {
      messages: [{ body: { type: "reminders", attempts: 2 }, ack: ackKnown, retry: retryKnown }],
    } as unknown as Parameters<typeof worker.queue>[0];

    const env = {
      BASE_URL: "https://calendar.example",
      DB: { prepare: vi.fn() },
      UPLOADS: { put: vi.fn(), get: vi.fn() },
      REMINDERS_WEBHOOK_URL: "https://jobs.example/reminders",
      JOBS_DLQ: { send: dlqSend },
    } as unknown as Parameters<typeof worker.queue>[1];

    await worker.queue(batch, env);

    expect(dlqSend).toHaveBeenCalledTimes(1);
    expect(retryKnown).not.toHaveBeenCalled();
    expect(ackKnown).toHaveBeenCalledTimes(1);
  });

});
