import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncRemoteActorAndEvents, verifyInboxRequest } from "./federation";

const upsertRemoteActor = vi.fn(async () => undefined);
const upsertRemoteEvent = vi.fn(async () => undefined);
const dbRun = vi.fn(async () => ({ success: true }));
const dbBind = vi.fn(() => ({ run: dbRun }));
const dbPrepare = vi.fn(() => ({ bind: dbBind }));

vi.mock("./storage", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./storage")>();
  return {
    ...mod,
    CloudflareStorage: vi.fn().mockImplementation(() => ({
      upsertRemoteActor,
      upsertRemoteEvent,
    })),
  };
});

describe("syncRemoteActorAndEvents", () => {
  beforeEach(() => {
    upsertRemoteActor.mockReset();
    upsertRemoteEvent.mockReset();
    dbRun.mockReset();
    dbBind.mockReset();
    dbPrepare.mockReset();
    dbPrepare.mockImplementation(() => ({ bind: dbBind }));
    dbBind.mockImplementation(() => ({ run: dbRun }));
    vi.unstubAllGlobals();
  });

  it("syncs paginated outbox events and upserts each event", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        preferredUsername: "bob",
        name: "Bob",
        inbox: "https://remote.example/inbox",
        outbox: "https://remote.example/users/bob/outbox",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        orderedItems: [
          { object: { type: "Event", id: "https://remote.example/events/1", name: "A", startTime: "2030-01-01T00:00:00.000Z" } },
        ],
        next: "https://remote.example/users/bob/outbox?page=2",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        orderedItems: [
          { object: { type: "Event", id: "https://remote.example/events/2", name: "B", startTime: "2030-01-02T00:00:00.000Z" } },
        ],
      }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const result = await syncRemoteActorAndEvents({
      env: {
        BASE_URL: "https://calendar.example",
        DB: { prepare: dbPrepare },
        UPLOADS: { put: vi.fn(), get: vi.fn() },
      } as never,
      actorUri: "https://remote.example/users/bob",
    });

    expect(result.actor?.uri).toBe("https://remote.example/users/bob");
    expect(result.eventsSynced).toBe(2);
    expect(upsertRemoteActor).toHaveBeenCalledTimes(1);
    expect(upsertRemoteEvent).toHaveBeenCalledTimes(2);
  });

  it("prunes stale remote events when sync traversal completes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        preferredUsername: "bob",
        name: "Bob",
        inbox: "https://remote.example/inbox",
        outbox: "https://remote.example/users/bob/outbox",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        orderedItems: [
          { object: { type: "Event", id: "https://remote.example/events/1", name: "A", startTime: "2030-01-01T00:00:00.000Z" } },
        ],
      }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    await syncRemoteActorAndEvents({
      env: {
        BASE_URL: "https://calendar.example",
        DB: { prepare: dbPrepare },
        UPLOADS: { put: vi.fn(), get: vi.fn() },
      } as never,
      actorUri: "https://remote.example/users/bob",
    });

    expect(dbPrepare).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM remote_events WHERE actor_uri = ?1 AND uri NOT IN"));
    expect(dbBind).toHaveBeenCalledWith("https://remote.example/users/bob", "https://remote.example/events/1");
  });

  it("does not prune stale events when outbox traversal is incomplete", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        preferredUsername: "bob",
        name: "Bob",
        inbox: "https://remote.example/inbox",
        outbox: "https://remote.example/users/bob/outbox",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

    vi.stubGlobal("fetch", fetchMock);

    await syncRemoteActorAndEvents({
      env: {
        BASE_URL: "https://calendar.example",
        DB: { prepare: dbPrepare },
        UPLOADS: { put: vi.fn(), get: vi.fn() },
      } as never,
      actorUri: "https://remote.example/users/bob",
    });

    const pruneCall = dbPrepare.mock.calls.find((args) => String(args[0]).includes("uri NOT IN"));
    expect(pruneCall).toBeUndefined();
  });

  it("removes deleted events from remote cache when Delete activities are received", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        preferredUsername: "bob",
        name: "Bob",
        inbox: "https://remote.example/inbox",
        outbox: "https://remote.example/users/bob/outbox",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        orderedItems: [
          { type: "Delete", object: "https://remote.example/events/old" },
        ],
      }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    await syncRemoteActorAndEvents({
      env: {
        BASE_URL: "https://calendar.example",
        DB: { prepare: dbPrepare },
        UPLOADS: { put: vi.fn(), get: vi.fn() },
      } as never,
      actorUri: "https://remote.example/users/bob",
    });

    expect(dbPrepare).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM remote_events WHERE actor_uri = ?1 AND uri IN"));
    expect(dbBind).toHaveBeenCalledWith("https://remote.example/users/bob", "https://remote.example/events/old");
  });


});

describe("verifyInboxRequest", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects signatures missing required signed headers", async () => {
    const req = new Request("https://calendar.example/inbox", {
      method: "POST",
      headers: {
        signature: 'keyId="https://remote.example/users/alice#main-key",algorithm="rsa-sha256",headers="host",signature="abc"',
      },
      body: JSON.stringify({ type: "Follow" }),
    });

    const result = await verifyInboxRequest({ request: req, activity: { actor: "https://remote.example/users/alice" } });
    expect(result).toEqual({ ok: false, status: 401, error: "missing_required_signature_headers" });
  });

  it("rejects signatures whose keyId does not match actor", async () => {
    const req = new Request("https://calendar.example/inbox", {
      method: "POST",
      headers: {
        signature: 'keyId="https://remote.example/users/bob#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="abc"',
      },
      body: JSON.stringify({ type: "Follow" }),
    });

    const result = await verifyInboxRequest({ request: req, activity: { actor: "https://remote.example/users/alice" } });
    expect(result).toEqual({ ok: false, status: 401, error: "key_mismatch" });
  });

  it("rejects unsupported signature algorithm", async () => {
    const req = new Request("https://calendar.example/inbox", {
      method: "POST",
      headers: {
        signature: 'keyId="https://remote.example/users/alice#main-key",algorithm="ed25519",headers="(request-target) host date digest",signature="abc"',
      },
      body: JSON.stringify({ type: "Follow", actor: "https://remote.example/users/alice" }),
    });

    const result = await verifyInboxRequest({ request: req, activity: { actor: "https://remote.example/users/alice" } });
    expect(result).toEqual({ ok: false, status: 401, error: "unsupported_signature_algorithm" });
  });

  it("rejects stale signature date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:10:00.000Z"));
    const body = JSON.stringify({ type: "Follow", actor: "https://remote.example/users/alice" });
    const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const digest = btoa(String.fromCharCode(...new Uint8Array(digestBytes)));

    const req = new Request("https://calendar.example/inbox", {
      method: "POST",
      headers: {
        signature: 'keyId="https://remote.example/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="abc="',
        digest: `SHA-256=${digest}`,
        date: "Tue, 01 Jan 2030 00:00:00 GMT",
      },
      body,
    });

    const result = await verifyInboxRequest({ request: req, activity: { actor: "https://remote.example/users/alice" } });
    expect(result).toEqual({ ok: false, status: 401, error: "stale_or_invalid_date" });
  });
});
