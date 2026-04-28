import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";

vi.mock("../src/lib/federation.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/federation.js")>("../src/lib/federation.js");
  return {
    ...actual,
    resolveRemoteActor: vi.fn(),
    discoverDomainActors: vi.fn(),
  };
});

import { federationRoutes } from "../src/routes/federation-api.js";
import { resolveRemoteActor, discoverDomainActors } from "../src/lib/federation.js";

function makeApp(db: DB, userId = "owner", username = "owner") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", { id: userId, username, displayName: username });
    await next();
  });
  app.route("/api/v1/federation", federationRoutes(db));
  return app;
}

describe("federation search SSRF protections", () => {
  let db: DB;
  const fetchMock = vi.fn();

  beforeEach(() => {
    db = initDatabase(":memory:");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.mocked(resolveRemoteActor).mockReset();
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: "https://remote.example/users/alice",
      type: "Person",
      preferred_username: "alice",
      display_name: "Alice",
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: null,
      shared_inbox: null,
      followers_url: null,
      following_url: null,
      followers_count: null,
      following_count: null,
      icon_url: null,
      image_url: null,
      public_key_id: null,
      public_key_pem: null,
      domain: "remote.example",
      last_fetched_at: new Date().toISOString(),
    });
    vi.mocked(discoverDomainActors).mockResolvedValue({ discovered: 0, software: null });
  });

  it("blocks private/local WebFinger domains before network fetch", async () => {
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/federation/search?q=alice@localhost");

    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveRemoteActor).not.toHaveBeenCalled();
  });

  it("uses safe WebFinger fetch and resolves actor on public domain", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        links: [
          { rel: "self", type: "application/activity+json", href: "https://remote.example/users/alice" },
        ],
      }),
    } as Response);

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/federation/search?q=alice@remote.example");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("error");
    expect(vi.mocked(resolveRemoteActor)).toHaveBeenCalledWith(db, "https://remote.example/users/alice", true);
  });

  it("rejects unsafe actor href returned by WebFinger", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        links: [
          { rel: "self", type: "application/activity+json", href: "http://127.0.0.1/users/alice" },
        ],
      }),
    } as Response);

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/federation/search?q=alice@remote.example");

    expect(res.status).toBe(400);
    expect(resolveRemoteActor).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid maxAgeHours on refresh-actors", async () => {
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/federation/refresh-actors?maxAgeHours=abc", {
      method: "POST",
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe("maxAgeHours must be a non-negative integer");
  });

  it("returns 400 for negative maxAgeHours on refresh-actors", async () => {
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/federation/refresh-actors?maxAgeHours=-1", {
      method: "POST",
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe("maxAgeHours must be a non-negative integer");
  });

  it("defaults maxAgeHours to 24 when omitted", async () => {
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/federation/refresh-actors", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { refreshed?: number; discovered?: number };
    expect(body.refreshed).toBe(0);
    expect(body.discovered).toBe(0);
  });
});
