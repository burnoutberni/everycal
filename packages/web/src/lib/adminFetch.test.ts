// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onUnauthorized } from "./api";
import { adminFetch } from "./adminFetch";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("adminFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    document.cookie = "everycal_csrf=test-csrf-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = "everycal_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  });

  it("includes credentials and CSRF header for non-GET requests", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }, { status: 200 }));

    await adminFetch("/api/v1/admin/example", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/admin/example",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({ ok: true }),
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-CSRF-Token": "test-csrf-token",
        }),
      })
    );
  });

  it("does not attach CSRF header for GET requests", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }, { status: 200 }));

    await adminFetch("/api/v1/admin/example");

    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBeUndefined();
  });

  it("surfaces server JSON errors with status", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "common.forbidden" }, { status: 403 }));

    await expect(adminFetch("/api/v1/admin/example")).rejects.toThrow("common.forbidden (403)");
  });

  it("falls back to a generic status error when JSON error is missing", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));

    await expect(adminFetch("/api/v1/admin/example")).rejects.toThrow("Request failed (401)");
  });

  it("notifies unauthorized listeners on 401", async () => {
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));

    await expect(adminFetch("/api/v1/admin/example")).rejects.toThrow("Request failed (401)");

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
