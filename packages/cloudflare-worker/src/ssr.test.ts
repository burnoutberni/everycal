import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareStorage } from "./storage";

const renderPage = vi.fn();

vi.mock("vike/server", () => ({
  renderPage,
}));

import { renderWorkerHtml } from "./ssr";

describe("renderWorkerHtml", () => {
  beforeEach(() => {
    renderPage.mockReset();
    vi.restoreAllMocks();
  });

  it("skips non-HTML requests", async () => {
    const request = new Request("https://calendar.example/", {
      method: "GET",
      headers: { accept: "application/json" },
    });

    const response = await renderWorkerHtml(request, {} as never);
    expect(response).toBeNull();
    expect(renderPage).not.toHaveBeenCalled();
  });

  it("skips API namespace requests", async () => {
    const request = new Request("https://calendar.example/api/v1/bootstrap", {
      method: "GET",
      headers: { accept: "text/html" },
    });

    const response = await renderWorkerHtml(request, {} as never);
    expect(response).toBeNull();
    expect(renderPage).not.toHaveBeenCalled();
  });

  it("adds anonymous edge-cache headers to SSR responses", async () => {
    vi.spyOn(CloudflareStorage.prototype, "getSession").mockResolvedValue(null);
    vi.spyOn(CloudflareStorage.prototype, "getAccountById").mockResolvedValue(null);
    renderPage.mockResolvedValueOnce({
      httpResponse: {
        body: "<html>ok</html>",
        statusCode: 200,
        headers: [["content-type", "text/html"]],
      },
    });

    const request = new Request("https://calendar.example/", {
      method: "GET",
      headers: { accept: "text/html" },
    });

    const response = await renderWorkerHtml(request, { SSR_CACHE_TAG_VERSION: "v2" } as never);
    expect(response?.headers.get("Cache-Control")).toBe("public, max-age=0, s-maxage=15, stale-while-revalidate=30");
    expect(response?.headers.get("X-SSR-Cache")).toBe("EDGE_HINT");
    expect(response?.headers.get("Cache-Tag")).toBe("everycal-ssr,everycal-ssr-anon,everycal-ssr-v2");
    expect(response?.headers.get("Vary")).toContain("Cache-Control");
  });

  it("bypasses anonymous edge cache when request asks for no-cache", async () => {
    vi.spyOn(CloudflareStorage.prototype, "getSession").mockResolvedValue(null);
    vi.spyOn(CloudflareStorage.prototype, "getAccountById").mockResolvedValue(null);
    renderPage.mockResolvedValueOnce({
      httpResponse: {
        body: "<html>ok</html>",
        statusCode: 200,
        headers: [["content-type", "text/html"]],
      },
    });

    const request = new Request("https://calendar.example/", {
      method: "GET",
      headers: { accept: "text/html", "cache-control": "no-cache" },
    });

    const response = await renderWorkerHtml(request, {} as never);
    expect(response?.headers.get("X-SSR-Cache")).toBe("BYPASS_REQUEST");
    expect(response?.headers.get("CDN-Cache-Control")).toBe("public, max-age=0, no-store");
  });

  it("supports rollout guardrail to disable anonymous edge cache", async () => {
    vi.spyOn(CloudflareStorage.prototype, "getSession").mockResolvedValue(null);
    vi.spyOn(CloudflareStorage.prototype, "getAccountById").mockResolvedValue(null);
    renderPage.mockResolvedValueOnce({
      httpResponse: {
        body: "<html>ok</html>",
        statusCode: 200,
        headers: [["content-type", "text/html"]],
      },
    });

    const request = new Request("https://calendar.example/", {
      method: "GET",
      headers: { accept: "text/html" },
    });

    const response = await renderWorkerHtml(request, { SSR_EDGE_CACHE_ENABLED: "false" } as never);
    expect(response?.headers.get("X-SSR-Cache")).toBe("DISABLED");
    expect(response?.headers.get("CDN-Cache-Control")).toBe("public, max-age=0, no-store");
  });

  it("adds authenticated no-store headers to SSR responses", async () => {
    vi.spyOn(CloudflareStorage.prototype, "getSession").mockResolvedValue({
      token: "t",
      accountId: "acct-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    vi.spyOn(CloudflareStorage.prototype, "getAccountById").mockResolvedValue({
      id: "acct-1",
      username: "alice",
      displayName: "Alice",
      avatarUrl: null,
      passwordHash: "x",
    });

    renderPage.mockResolvedValueOnce({
      httpResponse: {
        body: "<html>private</html>",
        statusCode: 200,
        headers: [["content-type", "text/html"]],
      },
    });

    const request = new Request("https://calendar.example/private", {
      method: "GET",
      headers: { accept: "text/html", cookie: "everycal_session=t" },
    });

    const response = await renderWorkerHtml(request, {} as never);
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response?.headers.get("X-SSR-Cache")).toBe("BYPASS_AUTH");
  });

  it("restores internal API origin global after render", async () => {
    const key = "__EVERYCAL_INTERNAL_API_ORIGIN";
    (globalThis as Record<string, unknown>)[key] = "previous-origin";
    vi.spyOn(CloudflareStorage.prototype, "getSession").mockResolvedValue(null);
    vi.spyOn(CloudflareStorage.prototype, "getAccountById").mockResolvedValue(null);

    renderPage.mockResolvedValueOnce({
      httpResponse: {
        body: "<html>ok</html>",
        statusCode: 200,
        headers: [["content-type", "text/html"]],
      },
    });

    const request = new Request("https://calendar.example/", {
      method: "GET",
      headers: { accept: "text/html" },
    });

    await renderWorkerHtml(request, {} as never);

    expect((globalThis as Record<string, unknown>)[key]).toBe("previous-origin");
  });
});
