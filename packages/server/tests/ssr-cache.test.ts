import { describe, expect, it } from "vitest";
import {
  buildSsrCacheKey,
  cacheAnonymousSsrResponse,
  getCachedSsrResponse,
  type CachedSsrResponse,
} from "../src/ssr/cache.js";

describe("SSR cache", () => {
  it("builds locale-aware keys", () => {
    const deKey = buildSsrCacheKey("https://everycal.com/discover?page=1", "de", false);
    const enKey = buildSsrCacheKey("https://everycal.com/discover?page=1", "en", false);
    expect(deKey).not.toBe(enKey);
  });

  it("drops set-cookie when caching anonymous html", () => {
    const cache = new Map<string, CachedSsrResponse>();
    cacheAnonymousSsrResponse({
      cache,
      key: "k",
      body: "<html></html>",
      statusCode: 200,
      headers: [
        ["content-type", "text/html"],
        ["set-cookie", "everycal_locale=de"],
      ],
      ttlMs: 1000,
    });

    const cached = cache.get("k");
    expect(cached).toBeTruthy();
    expect(cached?.headers.some(([name]) => name.toLowerCase() === "set-cookie")).toBe(false);
  });

  it("expires stale entries", () => {
    const cache = new Map<string, CachedSsrResponse>([
      [
        "stale",
        {
          body: "x",
          statusCode: 200,
          headers: [],
          expiresAt: Date.now() - 1,
        },
      ],
    ]);

    expect(getCachedSsrResponse(cache, "stale")).toBeUndefined();
    expect(cache.has("stale")).toBe(false);
  });
});
