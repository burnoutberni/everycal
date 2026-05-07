import { describe, expect, it, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { authMiddleware, createSession } from "../src/middleware/auth.js";
import { activityPubRoutes, sharedInboxRoute } from "../src/routes/activitypub.js";
import { federationRoutes } from "../src/routes/federation-api.js";
import { serializeRemoteEvent } from "../src/lib/event-serializers.js";
import { upsertRemoteEvent } from "../src/lib/remote-events.js";
import * as remoteEvents from "../src/lib/remote-events.js";
import * as federation from "../src/lib/federation.js";
import { generateKeyPair } from "../src/lib/crypto.js";

function insertAccount(db: DB, id = "acct1", username = "alice") {
  const keys = generateKeyPair();
  db.prepare("INSERT INTO accounts (id, username, private_key, public_key) VALUES (?, ?, ?, ?)").run(id, username, keys.privateKey, keys.publicKey);
  return { id, username, ...keys };
}

function insertRemoteActor(db: DB, uri = "https://remote.example/users/bob") {
  db.prepare("INSERT INTO remote_actors (uri, type, preferred_username, inbox, outbox, domain) VALUES (?, 'Person', 'bob', ?, ?, 'remote.example')")
    .run(uri, "https://remote.example/inbox", "https://remote.example/users/bob/outbox");
  return uri;
}

function eventObject(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "Event",
    name,
    startTime: "2026-06-01T10:00:00Z",
    attributedTo: "https://remote.example/users/bob",
    ...extra,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.SKIP_SIGNATURE_VERIFY;
});

describe("federation hardening prep", () => {
  it("derives, stores, and serializes remote visibility", () => {
    const db = initDatabase(":memory:");
    const actorUri = insertRemoteActor(db);

    upsertRemoteEvent(db, eventObject("https://remote.example/events/unlisted", "Unlisted", {
      to: ["https://remote.example/users/bob/followers"],
      cc: [federation.AP_PUBLIC],
    }), actorUri);

    const row = db.prepare("SELECT re.*, ra.preferred_username, ra.domain FROM remote_events re JOIN remote_actors ra ON ra.uri = re.actor_uri WHERE re.uri = ?")
      .get("https://remote.example/events/unlisted") as Record<string, unknown>;
    expect(row.visibility).toBe("unlisted");
    expect(serializeRemoteEvent(row).visibility).toBe("unlisted");
  });

  it("maps outbound audiences distinctly by visibility", () => {
    const actor = "https://local.example/users/alice";
    expect(federation.visibilityToActivityPubAddressing("public", actor)).toEqual({ to: [federation.AP_PUBLIC], cc: [`${actor}/followers`] });
    expect(federation.visibilityToActivityPubAddressing("unlisted", actor)).toEqual({ to: [`${actor}/followers`], cc: [federation.AP_PUBLIC] });
    expect(federation.visibilityToActivityPubAddressing("followers_only", actor)).toEqual({ to: [`${actor}/followers`], cc: [] });
    expect(federation.visibilityToActivityPubAddressing("private", actor)).toEqual({ to: [], cc: [] });
  });

  it("retries durable outbound deliveries and eventually marks terminal failure", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "try later" }));
    federation.enqueueOutboundDelivery(db, {
      destinationInbox: "https://remote.example/inbox",
      senderAccountId: account.id,
      senderActorUri: "http://localhost:3000/users/alice",
      activity: { id: "http://localhost/activity/1", type: "Create" },
    });

    await federation.processOutboundDeliveryQueue(db, 1);
    const firstRetry = db.prepare("SELECT next_retry_at FROM outbound_activity_deliveries").get() as {
      next_retry_at: string;
    };
    expect(firstRetry.next_retry_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    for (let i = 0; i < 5; i++) {
      db.prepare("UPDATE outbound_activity_deliveries SET next_retry_at = datetime('now')").run();
      await federation.processOutboundDeliveryQueue(db);
    }

    const row = db.prepare("SELECT state, attempt_count, last_error FROM outbound_activity_deliveries").get() as { state: string; attempt_count: number; last_error: string };
    expect(row.state).toBe("failed");
    expect(row.attempt_count).toBe(5);
    expect(row.last_error).toContain("failed after 5 attempts");
  });

  it("atomically claims pending jobs and recovers stale processing claims", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 202, text: async () => "" }));

    const activeClaimId = federation.enqueueOutboundDelivery(db, {
      destinationInbox: "https://remote.example/inbox",
      senderAccountId: account.id,
      senderActorUri: "http://localhost:3000/users/alice",
      activity: { id: "http://localhost/activity/active-claim", type: "Create" },
    });
    const staleClaimId = federation.enqueueOutboundDelivery(db, {
      destinationInbox: "https://remote.example/inbox",
      senderAccountId: account.id,
      senderActorUri: "http://localhost:3000/users/alice",
      activity: { id: "http://localhost/activity/stale-claim", type: "Create" },
    });

    db.prepare(
      "UPDATE outbound_activity_deliveries SET state = 'processing', worker_id = ?, claimed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run("other-worker", activeClaimId);
    db.prepare(
      "UPDATE outbound_activity_deliveries SET state = 'processing', worker_id = ?, claimed_at = datetime('now', '-20 minutes'), updated_at = datetime('now') WHERE id = ?"
    ).run("dead-worker", staleClaimId);

    const result = await federation.processOutboundDeliveryQueue(db, 5);
    expect(result.processed).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);

    const activeClaim = db.prepare("SELECT state FROM outbound_activity_deliveries WHERE id = ?").get(activeClaimId) as { state: string };
    expect(activeClaim.state).toBe("processing");

    const staleClaim = db.prepare("SELECT state, attempt_count, worker_id, claimed_at FROM outbound_activity_deliveries WHERE id = ?").get(staleClaimId) as {
      state: string;
      attempt_count: number;
      worker_id: string | null;
      claimed_at: string | null;
    };
    expect(staleClaim.state).toBe("delivered");
    expect(staleClaim.attempt_count).toBe(1);
    expect(staleClaim.worker_id).toBeNull();
    expect(staleClaim.claimed_at).toBeNull();
  });

  it("skips duplicate inbox activities with stable ids", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const activity = (name: string) => ({
      id: "https://remote.example/activities/create-1",
      type: "Create",
      actor: "https://remote.example/users/bob",
      object: eventObject("https://remote.example/events/dupe", name, { to: [federation.AP_PUBLIC] }),
    });

    expect((await app.request("http://localhost/users/alice/inbox", { method: "POST", body: JSON.stringify(activity("First")) })).status).toBe(202);
    const second = await app.request("http://localhost/users/alice/inbox", { method: "POST", body: JSON.stringify(activity("Second")) });
    expect(second.status).toBe(202);
    expect((await second.json() as { duplicate?: boolean }).duplicate).toBe(true);
    const row = db.prepare("SELECT title FROM remote_events WHERE uri = ?").get("https://remote.example/events/dupe") as { title: string };
    expect(row.title).toBe("First");
  });

  it("releases inbox dedupe claim when processing fails", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/users", activityPubRoutes(db));

    const activity = {
      id: "https://remote.example/activities/create-retry-1",
      type: "Create",
      actor: "https://remote.example/users/bob",
      object: eventObject("https://remote.example/events/retry", "Recovered", { to: [federation.AP_PUBLIC] }),
    };

    const realUpsert = remoteEvents.upsertRemoteEvent;
    const upsertSpy = vi.spyOn(remoteEvents, "upsertRemoteEvent");
    upsertSpy.mockImplementationOnce(() => {
      throw new Error("transient failure");
    });
    upsertSpy.mockImplementation(realUpsert);

    const first = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify(activity),
    });
    expect(first.status).toBe(500);

    const second = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      body: JSON.stringify(activity),
    });
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ ok: true });

    const row = db.prepare("SELECT title FROM remote_events WHERE uri = ?").get("https://remote.example/events/retry") as { title: string };
    expect(row.title).toBe("Recovered");
  });

  it("skips duplicate shared inbox activities with stable ids", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/", sharedInboxRoute(db));

    const activity = (name: string) => ({
      id: "https://remote.example/activities/shared-create-1",
      type: "Create",
      actor: "https://remote.example/users/bob",
      object: eventObject("https://remote.example/events/shared-dupe", name, { to: [federation.AP_PUBLIC] }),
    });

    expect((await app.request("http://localhost/inbox", { method: "POST", body: JSON.stringify(activity("First")) })).status).toBe(202);
    const second = await app.request("http://localhost/inbox", {
      method: "POST",
      body: JSON.stringify(activity("Second")),
    });
    expect(second.status).toBe(202);
    expect((await second.json() as { duplicate?: boolean }).duplicate).toBe(true);
    const row = db.prepare("SELECT title FROM remote_events WHERE uri = ?").get("https://remote.example/events/shared-dupe") as { title: string };
    expect(row.title).toBe("First");
  });

  it("releases shared inbox dedupe claim when processing fails", async () => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    const db = initDatabase(":memory:");
    insertAccount(db, "local1", "alice");
    insertRemoteActor(db);
    const app = new Hono();
    app.route("/", sharedInboxRoute(db));

    const activity = {
      id: "https://remote.example/activities/shared-create-retry-1",
      type: "Create",
      actor: "https://remote.example/users/bob",
      object: eventObject("https://remote.example/events/shared-retry", "Recovered", { to: [federation.AP_PUBLIC] }),
    };

    const realUpsert = remoteEvents.upsertRemoteEvent;
    const upsertSpy = vi.spyOn(remoteEvents, "upsertRemoteEvent");
    upsertSpy.mockImplementationOnce(() => {
      throw new Error("transient failure");
    });
    upsertSpy.mockImplementation(realUpsert);

    const first = await app.request("http://localhost/inbox", {
      method: "POST",
      body: JSON.stringify(activity),
    });
    expect(first.status).toBe(500);

    const second = await app.request("http://localhost/inbox", {
      method: "POST",
      body: JSON.stringify(activity),
    });
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ ok: true });

    const row = db.prepare("SELECT title FROM remote_events WHERE uri = ?").get("https://remote.example/events/shared-retry") as { title: string };
    expect(row.title).toBe("Recovered");
  });

  it("pull import processes Update and Delete with actor ownership checks", async () => {
    const db = initDatabase(":memory:");
    const account = insertAccount(db, "local1", "alice");
    const token = createSession(db, account.id).token;
    const actorUri = insertRemoteActor(db);
    upsertRemoteEvent(db, eventObject("https://remote.example/events/pulled", "Old", { to: [federation.AP_PUBLIC] }), actorUri);

    vi.spyOn(federation, "resolveRemoteActor").mockResolvedValue({
      uri: actorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: null,
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/users/bob/outbox",
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
    vi.spyOn(federation, "fetchRemoteOutbox").mockResolvedValue([
      { id: "https://remote.example/activities/update", type: "Update", actor: actorUri, object: eventObject("https://remote.example/events/pulled", "New", { to: ["https://remote.example/users/bob/followers"], cc: [federation.AP_PUBLIC] }) },
      { id: "https://remote.example/activities/delete", type: "Delete", actor: actorUri, object: "https://remote.example/events/pulled" },
    ]);

    const app = new Hono();
    app.use("*", authMiddleware(db));
    app.route("/api/v1/federation", federationRoutes(db));
    const res = await app.request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ actorUri }),
    });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT title, visibility, canceled FROM remote_events WHERE uri = ?").get("https://remote.example/events/pulled") as { title: string; visibility: string; canceled: number };
    expect(row).toEqual({ title: "New", visibility: "unlisted", canceled: 1 });
  });
});
