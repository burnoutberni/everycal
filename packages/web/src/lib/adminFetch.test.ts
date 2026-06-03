// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
        body: JSON.stringify({ ok: true }),
        headers: expect.any(Headers),
      })
    );

    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-CSRF-Token")).toBe("test-csrf-token");
  });

  it("does not attach CSRF header for GET requests", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }, { status: 200 }));

    await adminFetch("/api/v1/admin/example");

    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("X-CSRF-Token")).toBeNull();
  });

  it("surfaces server JSON errors with status", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "common.forbidden" }, { status: 403 }));

    await expect(adminFetch("/api/v1/admin/example")).rejects.toThrow("common.forbidden (403)");
  });

  it("falls back to a generic status error when JSON error is missing", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));

    await expect(adminFetch("/api/v1/admin/example")).rejects.toThrow("Request failed (401)");
  });
});
