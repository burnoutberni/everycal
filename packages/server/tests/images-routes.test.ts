import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

async function loadImageRoutes(unsplashAccessKey: string | undefined) {
  const previousKey = process.env.UNSPLASH_ACCESS_KEY;
  if (unsplashAccessKey === undefined) {
    delete process.env.UNSPLASH_ACCESS_KEY;
  } else {
    process.env.UNSPLASH_ACCESS_KEY = unsplashAccessKey;
  }

  vi.resetModules();
  const { imageRoutes } = await import("../src/routes/images.js");

  if (previousKey === undefined) {
    delete process.env.UNSPLASH_ACCESS_KEY;
  } else {
    process.env.UNSPLASH_ACCESS_KEY = previousKey;
  }

  return imageRoutes;
}

function makeApp(imageRoutesFactory: () => Hono, authenticated = true) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", authenticated
      ? { id: "u1", username: "alice", displayName: "Alice" }
      : null);
    await next();
  });
  app.route("/api/v1/images", imageRoutesFactory());
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("imageRoutes trigger-download", () => {
  it("requires authentication", async () => {
    const imageRoutes = await loadImageRoutes("unsplash-test-key");
    const app = makeApp(imageRoutes, false);

    const res = await app.request("http://localhost/api/v1/images/trigger-download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ downloadLocation: "https://api.unsplash.com/photos/abc/download" }),
    });

    expect(res.status).toBe(401);
  });

  it("returns 400 for non-string downloadLocation payloads", async () => {
    const imageRoutes = await loadImageRoutes("unsplash-test-key");
    const app = makeApp(imageRoutes);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const invalidPayloads = [123, { url: "https://api.unsplash.com/photos/abc/download" }, ["x"], true, null];
    for (const invalidPayload of invalidPayloads) {
      const res = await app.request("http://localhost/api/v1/images/trigger-download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ downloadLocation: invalidPayload }),
      });
      expect(res.status).toBe(400);
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    const imageRoutes = await loadImageRoutes("unsplash-test-key");
    const app = makeApp(imageRoutes);

    const res = await app.request("http://localhost/api/v1/images/trigger-download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid Unsplash download URLs", async () => {
    const imageRoutes = await loadImageRoutes("unsplash-test-key");
    const app = makeApp(imageRoutes);

    const invalidUrls = [
      "not-a-url",
      "http://api.unsplash.com/photos/abc/download",
      "https://example.com/photos/abc/download",
      "https://api.unsplash.com/photos/abc",
      "https://api.unsplash.com/photos/a/b/download",
      "https://api.unsplash.com/photos//download",
      "https://api.unsplash.com/photos/abc/download/extra",
    ];

    for (const invalidUrl of invalidUrls) {
      const res = await app.request("http://localhost/api/v1/images/trigger-download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ downloadLocation: invalidUrl }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("tracks download for a valid Unsplash URL", async () => {
    const imageRoutes = await loadImageRoutes("unsplash-test-key");
    const app = makeApp(imageRoutes);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("http://localhost/api/v1/images/trigger-download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ downloadLocation: "  https://api.unsplash.com/photos/abc/download?foo=bar  " }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [calledUrl, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(calledUrl);
    expect(parsed.protocol).toBe("https:");
    expect(parsed.hostname).toBe("api.unsplash.com");
    expect(parsed.pathname).toBe("/photos/abc/download");
    expect(parsed.searchParams.get("foo")).toBe("bar");
    expect(parsed.searchParams.get("client_id")).toBe("unsplash-test-key");
    expect(options).toEqual({ redirect: "error" });
  });

  it("returns ok even when tracking fetch fails", async () => {
    const imageRoutes = await loadImageRoutes("unsplash-test-key");
    const app = makeApp(imageRoutes);
    const fetchMock = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("http://localhost/api/v1/images/trigger-download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ downloadLocation: "https://api.unsplash.com/photos/abc/download" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("returns 400 when Unsplash key is missing", async () => {
    const imageRoutes = await loadImageRoutes(undefined);
    const app = makeApp(imageRoutes);

    const res = await app.request("http://localhost/api/v1/images/trigger-download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ downloadLocation: "https://api.unsplash.com/photos/abc/download" }),
    });

    expect(res.status).toBe(400);
  });
});

describe("imageRoutes search and sources", () => {
  it("reports available sources based on Unsplash config", async () => {
    const imageRoutesWithKey = await loadImageRoutes("unsplash-test-key");
    const appWithKey = makeApp(imageRoutesWithKey);
    const withKeyRes = await appWithKey.request("http://localhost/api/v1/images/sources");
    expect(withKeyRes.status).toBe(200);
    await expect(withKeyRes.json()).resolves.toEqual({
      sources: ["unsplash", "openverse"],
      unsplashAvailable: true,
    });

    const imageRoutesWithoutKey = await loadImageRoutes(undefined);
    const appWithoutKey = makeApp(imageRoutesWithoutKey);
    const withoutKeyRes = await appWithoutKey.request("http://localhost/api/v1/images/sources");
    expect(withoutKeyRes.status).toBe(200);
    await expect(withoutKeyRes.json()).resolves.toEqual({
      sources: ["openverse"],
      unsplashAvailable: false,
    });
  });

  it("returns 400 when search query is too short", async () => {
    const imageRoutes = await loadImageRoutes("unsplash-test-key");
    const app = makeApp(imageRoutes);

    const res = await app.request("http://localhost/api/v1/images/search?q=a");
    expect(res.status).toBe(400);
  });

  it("falls back to Openverse when Unsplash fails in auto mode", async () => {
    const imageRoutes = await loadImageRoutes("unsplash-test-key");
    const app = makeApp(imageRoutes);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://api.unsplash.com/search/photos?")) {
        throw new Error("unsplash unavailable");
      }
      if (url.startsWith("https://api.openverse.org/v1/images/?")) {
        return new Response(JSON.stringify({
          results: [{
            url: "https://cdn.openverse.org/image.jpg",
            title: "Openverse Image",
            foreign_landing_url: "https://example.org/image",
            creator: "Jane Artist",
            creator_url: "https://example.org/jane",
            license: "by",
            license_url: "https://creativecommons.org/licenses/by/4.0/",
            attribution: "Photo by Jane Artist",
          }],
        }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("http://localhost/api/v1/images/search?q=sunset");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      source: "openverse",
      results: [{
        url: "https://cdn.openverse.org/image.jpg",
        attribution: {
          source: "openverse",
          title: "Openverse Image",
          sourceUrl: "https://example.org/image",
          creator: "Jane Artist",
          creatorUrl: "https://example.org/jane",
          license: "by",
          licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
          attribution: "Photo by Jane Artist",
        },
      }],
    });
  });
});
