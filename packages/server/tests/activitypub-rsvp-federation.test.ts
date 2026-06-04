import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";


vi.mock("../src/routes/og-images.js", () => ({
  clearRemoteOgImage: vi.fn().mockResolvedValue(undefined),
  generateAndSaveRemoteOgImage: vi.fn().mockResolvedValue(undefined),
  isRemoteActivityOgEligible: vi.fn().mockReturnValue(false),
  clearLocalOgImage: vi.fn().mockResolvedValue(undefined),
  generateAndSaveOgImage: vi.fn().mockResolvedValue(undefined),
  isOgEligibleVisibility: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/lib/federation.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/federation.js")>("../src/lib/federation.js");
  return {
    ...actual,
    resolveRemoteActor: vi.fn(),
    fetchRemoteOutbox: vi.fn(),
    fetchAP: vi.fn(),
    discoverDomainActors: vi.fn().mockResolvedValue(undefined),
  };
});

import { activityPubRoutes, sharedInboxRoute } from "../src/routes/activitypub.js";
import { eventRoutes } from "../src/routes/events.js";
import { federationRoutes } from "../src/routes/federation-api.js";
import { fetchRemoteOutbox, resolveRemoteActor } from "../src/lib/federation.js";
import { resetBoundedLogStateForTests } from "../src/lib/bounded-log.js";

const localEventUrl = "http://localhost/events/event-1";
const remoteActorUri = "https://remote.example/users/bob";

function seedLocalEvent(db: DB, visibility = "public"): void {
  db.prepare("INSERT INTO accounts (id, username, account_type, private_key, public_key) VALUES (?, ?, 'person', ?, ?)")
    .run("local1", "alice", "PRIVATE", "PUBLIC");
  db.prepare(
    `INSERT INTO events (
      id, account_id, title, start_date, start_at_utc, event_timezone, visibility
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("event-1", "local1", "Local Event", "2026-06-01T10:00:00", "2026-06-01T10:00:00.000Z", "UTC", visibility);
}

function seedOutboxModerationFixture(db: DB): void {
  db.prepare("INSERT INTO accounts (id, username, account_type, private_key, public_key) VALUES (?, ?, 'person', ?, ?)")
    .run("local1", "alice", "PRIVATE", "PUBLIC");
  db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')")
    .run("local2", "bob");

  const insertEvent = db.prepare(
    `INSERT INTO events (
      id, account_id, title, start_date, start_at_utc, event_timezone, visibility
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  insertEvent.run("owned-visible", "local1", "Owned Visible", "2026-06-01T10:00:00", "2026-06-01T10:00:00.000Z", "UTC", "public");
  insertEvent.run("owned-hidden", "local1", "Owned Hidden", "2026-06-02T10:00:00", "2026-06-02T10:00:00.000Z", "UTC", "public");
  insertEvent.run("repost-visible", "local2", "Repost Visible", "2026-06-03T10:00:00", "2026-06-03T10:00:00.000Z", "UTC", "public");
  insertEvent.run("repost-hidden", "local2", "Repost Hidden", "2026-06-04T10:00:00", "2026-06-04T10:00:00.000Z", "UTC", "public");
  insertEvent.run("auto-visible", "local2", "Auto Visible", "2026-06-05T10:00:00", "2026-06-05T10:00:00.000Z", "UTC", "public");
  insertEvent.run("auto-hidden", "local2", "Auto Hidden", "2026-06-06T10:00:00", "2026-06-06T10:00:00.000Z", "UTC", "public");

  db.prepare("UPDATE events SET moderation_state = 'hidden' WHERE id IN ('owned-hidden', 'repost-hidden', 'auto-hidden')").run();

  db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)")
    .run("local1", "repost-visible", "http://localhost/events/repost-visible", "http://localhost/users/bob");
  db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)")
    .run("local1", "repost-hidden", "http://localhost/events/repost-hidden", "http://localhost/users/bob");

  db.prepare("INSERT INTO auto_reposts (account_id, source_account_id, source_actor_uri) VALUES (?, ?, ?)")
    .run("local1", "local2", "http://localhost/users/bob");
}

function seedRemoteEvent(db: DB): void {
  db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("local1", "alice");
  db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain, outbox) VALUES (?, ?, ?, ?, ?)")
    .run("https://remote.example/users/organizer", "organizer", "https://remote.example/inbox", "remote.example", "https://remote.example/outbox");
  db.prepare(
    `INSERT INTO remote_events (
      uri, actor_uri, title, start_date, start_at_utc, timezone_quality, raw_json, visibility
    ) VALUES (?, ?, ?, ?, ?, 'offset_only', '{}', 'public')`,
  ).run("https://remote.example/events/remote-1", "https://remote.example/users/organizer", "Remote Event", "2026-06-01T10:00:00Z", "2026-06-01T10:00:00.000Z");
}

function inboxApp(db: DB): Hono {
  const app = new Hono();
  app.route("/users", activityPubRoutes(db));
  app.route("/", sharedInboxRoute(db));
  return app;
}

function authedApp(db: DB): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", { id: "local1", username: "alice", displayName: "Alice" });
    await next();
  });
  app.route("/api/v1/events", eventRoutes(db));
  app.route("/api/v1/federation", federationRoutes(db));
  return app;
}

async function postInbox(db: DB, activity: Record<string, unknown>, path = "/users/alice/inbox") {
  return inboxApp(db).request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/activity+json" },
    body: JSON.stringify(activity),
  });
}

function rsvpActivity(type: string, id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type,
    actor: remoteActorUri,
    object: {
      type: "Event",
      id: localEventUrl,
      attributedTo: "http://localhost/users/alice",
    },
    published: "2026-05-01T10:00:00Z",
    ...extra,
  };
}

describe("ActivityPub RSVP federation", () => {
  let db: DB;
  let prevSkipSignatureVerify: string | undefined;
  let prevBaseUrl: string | undefined;

  beforeEach(() => {
    prevSkipSignatureVerify = process.env.SKIP_SIGNATURE_VERIFY;
    prevBaseUrl = process.env.BASE_URL;
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    process.env.BASE_URL = "http://localhost";
    db = initDatabase(":memory:");
    vi.mocked(resolveRemoteActor).mockReset();
    vi.mocked(fetchRemoteOutbox).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetBoundedLogStateForTests();

    if (prevSkipSignatureVerify === undefined) {
      delete process.env.SKIP_SIGNATURE_VERIFY;
    } else {
      process.env.SKIP_SIGNATURE_VERIFY = prevSkipSignatureVerify;
    }

    if (prevBaseUrl === undefined) {
      delete process.env.BASE_URL;
    } else {
      process.env.BASE_URL = prevBaseUrl;
    }
  });

  it.each([
    ["Accept", "going"],
    ["Join", "going"],
    ["TentativeAccept", "maybe"],
    ["Reject", "not_going"],
    ["Leave", "not_going"],
  ])("handles inbound %s RSVP activities", async (type, expectedStatus) => {
    seedLocalEvent(db);
    const res = await postInbox(db, rsvpActivity(type, `https://remote.example/activities/${type}`));
    expect(res.status).toBe(202);
    const row = db.prepare("SELECT status, last_activity_type FROM remote_event_rsvps WHERE event_id = ? AND actor_uri = ?")
      .get("event-1", remoteActorUri) as { status: string; last_activity_type: string };
    expect(row).toEqual({ status: expectedStatus, last_activity_type: type });
  });

  it("parses object-form actors and Event objects while validating local ownership", async () => {
    seedLocalEvent(db);
    const res = await postInbox(db, rsvpActivity("Accept", "https://remote.example/activities/object-forms", {
      actor: { id: remoteActorUri },
      object: { type: "Event", id: localEventUrl, attributedTo: "http://localhost/users/alice" },
    }));
    expect(res.status).toBe(202);
    const row = db.prepare("SELECT status FROM remote_event_rsvps WHERE event_id = ? AND actor_uri = ?")
      .get("event-1", remoteActorUri) as { status: string };
    expect(row.status).toBe("going");
  });

  it("accepts object-form actor on non-RSVP user inbox activities", async () => {
    seedLocalEvent(db);
    const res = await postInbox(db, {
      id: "https://remote.example/activities/create-object-actor",
      type: "Create",
      actor: { id: remoteActorUri },
      object: {
        type: "Note",
        id: "https://remote.example/notes/1",
      },
    });

    expect(res.status).toBe(202);
    const processed = db.prepare(
      "SELECT status FROM processed_inbox_activities WHERE activity_id = ? AND actor_uri = ? AND target_context = ?",
    ).get(
      "https://remote.example/activities/create-object-actor",
      remoteActorUri,
      "user:alice",
    ) as { status: string } | undefined;
    expect(processed?.status).toBe("processed");
  });

  it("accepts object-form actor on non-RSVP shared inbox activities", async () => {
    const res = await postInbox(
      db,
      {
        id: "https://remote.example/activities/shared-create-object-actor",
        type: "Create",
        actor: { id: remoteActorUri },
        object: {
          type: "Note",
          id: "https://remote.example/notes/2",
        },
      },
      "/inbox",
    );

    expect(res.status).toBe(202);
    const processed = db.prepare(
      "SELECT status FROM processed_inbox_activities WHERE activity_id = ? AND actor_uri = ? AND target_context = ?",
    ).get(
      "https://remote.example/activities/shared-create-object-actor",
      remoteActorUri,
      "shared:inbox",
    ) as { status: string } | undefined;
    expect(processed?.status).toBe("processed");
  });

  it("accepts canonical local targets but rejects impersonation-like embedded metadata", async () => {
    seedLocalEvent(db);
    await postInbox(db, rsvpActivity("Accept", "https://remote.example/activities/string-object", {
      object: localEventUrl,
    }));
    await postInbox(db, rsvpActivity("Accept", "https://remote.example/activities/missing-attributed-to", {
      object: { type: "Event", id: localEventUrl },
    }));
    await postInbox(db, rsvpActivity("Accept", "https://remote.example/activities/forged-object-actor", {
      object: { type: "Event", id: localEventUrl, actor: "https://remote.example/users/eve" },
    }));
    await postInbox(db, rsvpActivity("Accept", "https://remote.example/activities/wrong-attributed-to", {
      object: { type: "Event", id: localEventUrl, attributedTo: "http://localhost/users/mallory" },
    }));
    await postInbox(db, rsvpActivity("Accept", "https://remote.example/activities/non-local", {
      object: "https://other.example/events/not-local",
    }));
    const rows = db.prepare("SELECT actor_uri, status FROM remote_event_rsvps").all() as { actor_uri: string; status: string }[];
    expect(rows).toEqual([{ actor_uri: remoteActorUri, status: "going" }]);
  });

  it("rejects inbound RSVP for local events that are not federation-eligible", async () => {
    seedLocalEvent(db, "private");
    const res = await postInbox(db, rsvpActivity("Accept", "https://remote.example/activities/private-target"));
    expect(res.status).toBe(202);
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM remote_event_rsvps").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("rate-limits logs for unknown RSVP verbs in inbox requests", async () => {
    seedLocalEvent(db);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const unknownRsvp = rsvpActivity("Interested", "https://remote.example/activities/interested-1");
    const secondUnknownRsvp = rsvpActivity("Interested", "https://remote.example/activities/interested-2");

    expect((await postInbox(db, unknownRsvp)).status).toBe(202);
    expect((await postInbox(db, secondUnknownRsvp)).status).toBe(202);
    const initialUnknownLogs = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("Ignored unknown RSVP activity type"));
    expect(initialUnknownLogs).toHaveLength(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect((await postInbox(db, rsvpActivity("Interested", "https://remote.example/activities/interested-3"))).status).toBe(202);

    const unknownLogs = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("Ignored unknown RSVP activity type"));
    expect(unknownLogs).toHaveLength(2);
    expect(unknownLogs[1]).toContain("suppressed 1 similar logs in last 300s");
  });

  it("deduplicates stable activity ids before applying RSVP mutations", async () => {
    seedLocalEvent(db);
    const first = await postInbox(db, rsvpActivity("Accept", "https://remote.example/activities/stable-dupe"));
    const second = await postInbox(db, rsvpActivity("TentativeAccept", "https://remote.example/activities/stable-dupe", {
      published: "2026-05-02T10:00:00Z",
    }));
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ duplicate: true });
    const row = db.prepare("SELECT status, last_activity_type FROM remote_event_rsvps WHERE event_id = ? AND actor_uri = ?")
      .get("event-1", remoteActorUri) as { status: string; last_activity_type: string };
    expect(row).toEqual({ status: "going", last_activity_type: "Accept" });
  });

  it("uses published timestamps and precedence for deterministic reordered RSVP outcomes", async () => {
    seedLocalEvent(db);
    await postInbox(db, rsvpActivity("Accept", "https://remote.example/activities/newer-accept", {
      published: "2026-05-03T10:00:00Z",
    }));
    await postInbox(db, rsvpActivity("Leave", "https://remote.example/activities/older-leave", {
      published: "2026-05-02T10:00:00Z",
    }));
    let row = db.prepare("SELECT status, last_activity_type FROM remote_event_rsvps WHERE event_id = ? AND actor_uri = ?")
      .get("event-1", remoteActorUri) as { status: string; last_activity_type: string };
    expect(row).toEqual({ status: "going", last_activity_type: "Accept" });

    await postInbox(db, rsvpActivity("Leave", "https://remote.example/activities/same-time-leave", {
      published: "2026-05-03T10:00:00Z",
    }));
    row = db.prepare("SELECT status, last_activity_type FROM remote_event_rsvps WHERE event_id = ? AND actor_uri = ?")
      .get("event-1", remoteActorUri) as { status: string; last_activity_type: string };
    expect(row).toEqual({ status: "not_going", last_activity_type: "Leave" });
  });

  it("falls back to updated when inbound RSVP published is invalid", async () => {
    seedLocalEvent(db);
    const res = await postInbox(db, rsvpActivity("Accept", "https://remote.example/activities/invalid-published", {
      published: "not-a-date",
      updated: "2026-05-03T10:00:00Z",
    }));
    expect(res.status).toBe(202);
    const row = db.prepare("SELECT last_activity_published_at FROM remote_event_rsvps WHERE event_id = ? AND actor_uri = ?")
      .get("event-1", remoteActorUri) as { last_activity_published_at: string | null };
    expect(row.last_activity_published_at).toBe("2026-05-03T10:00:00.000Z");
  });

  it("enqueues outbound RSVP activities through the durable delivery queue and skips no-op transitions", async () => {
    seedRemoteEvent(db);
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: "https://remote.example/users/organizer",
      type: "Person",
      preferred_username: "organizer",
      display_name: "Organizer",
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/outbox",
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
    const app = authedApp(db);
    const res = await app.request("http://localhost/api/v1/events/rsvp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventUri: "https://remote.example/events/remote-1", status: "going" }),
    });
    expect(res.status).toBe(200);
    const delivery = db.prepare("SELECT destination_inbox, sender_actor_uri, activity_json FROM outbound_activity_deliveries").get() as {
      destination_inbox: string;
      sender_actor_uri: string;
      activity_json: string;
    };
    const activity = JSON.parse(delivery.activity_json) as Record<string, unknown>;
    expect(delivery.destination_inbox).toBe("https://remote.example/inbox");
    expect(delivery.sender_actor_uri).toBe("http://localhost/users/alice");
    expect(activity.type).toBe("Accept");
    expect(activity.object).toBe("https://remote.example/events/remote-1");
    expect(activity.to).toEqual(["https://remote.example/users/organizer"]);

    const noop = await app.request("http://localhost/api/v1/events/rsvp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventUri: "https://remote.example/events/remote-1", status: "going" }),
    });
    expect(noop.status).toBe(200);
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM outbound_activity_deliveries").get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("generates unique outbound RSVP activity ids for updates in the same millisecond", async () => {
    seedRemoteEvent(db);
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: "https://remote.example/users/organizer",
      type: "Person",
      preferred_username: "organizer",
      display_name: "Organizer",
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/outbox",
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

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1710000000000);
    const app = authedApp(db);
    const first = await app.request("http://localhost/api/v1/events/rsvp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventUri: "https://remote.example/events/remote-1", status: "going" }),
    });
    const second = await app.request("http://localhost/api/v1/events/rsvp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventUri: "https://remote.example/events/remote-1", status: "maybe" }),
    });
    nowSpy.mockRestore();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const rows = db.prepare("SELECT activity_json FROM outbound_activity_deliveries ORDER BY id ASC").all() as Array<{
      activity_json: string;
    }>;
    expect(rows).toHaveLength(2);
    const ids = rows.map((row) => (JSON.parse(row.activity_json) as { id: string }).id);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toContain("/activities/");
    expect(ids[1]).toContain("/activities/");
    expect(ids[0]).not.toContain(encodeURIComponent("https://remote.example/events/remote-1"));
    expect(ids[1]).not.toContain(encodeURIComponent("https://remote.example/events/remote-1"));

    const mappings = db
      .prepare("SELECT activity_id, activity_type, object_uri FROM federation_activity_ids ORDER BY created_at ASC")
      .all() as Array<{ activity_id: string; activity_type: string; object_uri: string }>;
    expect(mappings).toHaveLength(2);
    expect(new Set(mappings.map((row) => row.activity_id))).toEqual(new Set(ids));
    expect(mappings.map((row) => row.activity_type)).toEqual(["Accept", "TentativeAccept"]);
    expect(mappings.map((row) => row.object_uri)).toEqual([
      "https://remote.example/events/remote-1",
      "https://remote.example/events/remote-1",
    ]);
  });

  it("uses stable opaque Announce activity IDs in outbox and persists mapping", async () => {
    seedLocalEvent(db);
    db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)")
      .run("local1", "event-1", "http://localhost/events/event-1", "http://localhost/users/alice");

    const app = inboxApp(db);
    const first = await app.request("http://localhost/users/alice/outbox?page=1", {
      method: "GET",
      headers: { accept: "application/activity+json" },
    });
    const second = await app.request("http://localhost/users/alice/outbox?page=1", {
      method: "GET",
      headers: { accept: "application/activity+json" },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstJson = await first.json() as { orderedItems?: Array<{ type?: string; id?: string }> };
    const secondJson = await second.json() as { orderedItems?: Array<{ type?: string; id?: string }> };
    const firstAnnounceId = firstJson.orderedItems?.find((item) => item.type === "Announce")?.id;
    const secondAnnounceId = secondJson.orderedItems?.find((item) => item.type === "Announce")?.id;
    expect(firstAnnounceId).toBeTruthy();
    expect(firstAnnounceId).toEqual(secondAnnounceId);
    expect(firstAnnounceId).toContain("/activities/");
    expect(firstAnnounceId).not.toContain("/announce/");
    const announceId = firstAnnounceId as string;

    const mapping = db
      .prepare("SELECT activity_id, logical_key, activity_type, object_uri FROM federation_activity_ids WHERE activity_id = ?")
      .get(announceId) as { activity_id: string; logical_key: string; activity_type: string; object_uri: string };
    expect(mapping.activity_id).toBe(announceId);
    expect(mapping.logical_key).toBe("announce:local1:http://localhost/events/event-1");
    expect(mapping.activity_type).toBe("Announce");
    expect(mapping.object_uri).toBe("http://localhost/events/event-1");
  });

  it("excludes hidden local events from outbox owned, repost, and auto-repost queries", async () => {
    seedOutboxModerationFixture(db);

    const app = inboxApp(db);
    const collectionRes = await app.request("http://localhost/users/alice/outbox", {
      method: "GET",
      headers: { accept: "application/activity+json" },
    });
    const pageRes = await app.request("http://localhost/users/alice/outbox?page=1", {
      method: "GET",
      headers: { accept: "application/activity+json" },
    });

    expect(collectionRes.status).toBe(200);
    expect(pageRes.status).toBe(200);

    const collection = await collectionRes.json() as { totalItems?: number };
    const page = await pageRes.json() as {
      orderedItems?: Array<{ type?: string; object?: unknown }>;
    };

    expect(collection.totalItems).toBe(3);

    const objectIds = (page.orderedItems ?? []).map((item) => {
      if (typeof item.object === "string") return item.object;
      if (item.object && typeof item.object === "object" && "id" in item.object) {
        return (item.object as { id?: string }).id;
      }
      return undefined;
    });
    expect(objectIds).toContain("http://localhost/events/owned-visible");
    expect(objectIds).toContain("http://localhost/events/repost-visible");
    expect(objectIds).toContain("http://localhost/events/auto-visible");
    expect(objectIds).not.toContain("http://localhost/events/owned-hidden");
    expect(objectIds).not.toContain("http://localhost/events/repost-hidden");
    expect(objectIds).not.toContain("http://localhost/events/auto-hidden");

    const createObjects = page.orderedItems
      ?.filter((item) => item.type === "Create")
      .map((item) => item.object) ?? [];
    expect(createObjects).toHaveLength(1);
    expect(createObjects[0]).toMatchObject({ id: "http://localhost/events/owned-visible" });
  });

  it("regenerates a full keypair when private_key exists but public_key is missing before enqueue", async () => {
    seedRemoteEvent(db);
    db.prepare("UPDATE accounts SET private_key = ?, public_key = NULL WHERE id = ?").run("LEGACY_PRIVATE", "local1");
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: "https://remote.example/users/organizer",
      type: "Person",
      preferred_username: "organizer",
      display_name: "Organizer",
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/outbox",
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

    const res = await authedApp(db).request("http://localhost/api/v1/events/rsvp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventUri: "https://remote.example/events/remote-1", status: "going" }),
    });

    expect(res.status).toBe(200);
    const accountKeys = db.prepare("SELECT public_key, private_key FROM accounts WHERE id = ?").get("local1") as {
      public_key: string | null;
      private_key: string | null;
    };
    expect(accountKeys.public_key).toBeTruthy();
    expect(accountKeys.private_key).toBeTruthy();
    expect(accountKeys.private_key).not.toBe("LEGACY_PRIVATE");
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM outbound_activity_deliveries").get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("imports RSVP activities from pull-sync outbox parity with the same local state mapping", async () => {
    seedLocalEvent(db);
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain, outbox) VALUES (?, ?, ?, ?, ?)")
      .run(remoteActorUri, "bob", "https://remote.example/inbox", "remote.example", "https://remote.example/outbox");
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: remoteActorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: "Bob",
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/outbox",
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
    vi.mocked(fetchRemoteOutbox).mockResolvedValue([
      rsvpActivity("TentativeAccept", "https://remote.example/activities/pulled-maybe"),
    ]);
    const res = await authedApp(db).request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: remoteActorUri }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 1, total: 1 });
    const row = db.prepare("SELECT status, last_activity_type FROM remote_event_rsvps WHERE event_id = ? AND actor_uri = ?")
      .get("event-1", remoteActorUri) as { status: string; last_activity_type: string };
    expect(row).toEqual({ status: "maybe", last_activity_type: "TentativeAccept" });
  });

  it("imports pulled RSVP when object is a canonical local event URI string", async () => {
    seedLocalEvent(db);
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain, outbox) VALUES (?, ?, ?, ?, ?)")
      .run(remoteActorUri, "bob", "https://remote.example/inbox", "remote.example", "https://remote.example/outbox");
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: remoteActorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: "Bob",
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/outbox",
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
    vi.mocked(fetchRemoteOutbox).mockResolvedValue([
      {
        id: "https://remote.example/activities/pulled-string-object",
        type: "Accept",
        actor: remoteActorUri,
        object: localEventUrl,
        published: "2026-05-01T10:00:00Z",
      },
    ]);

    const res = await authedApp(db).request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: remoteActorUri }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 1, total: 1 });

    const row = db.prepare("SELECT status, last_activity_type FROM remote_event_rsvps WHERE event_id = ? AND actor_uri = ?")
      .get("event-1", remoteActorUri) as { status: string; last_activity_type: string };
    expect(row).toEqual({ status: "going", last_activity_type: "Accept" });
  });

  it("does not increment imported for pulled RSVP activities that are handled but rejected", async () => {
    seedLocalEvent(db);
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain, outbox) VALUES (?, ?, ?, ?, ?)")
      .run(remoteActorUri, "bob", "https://remote.example/inbox", "remote.example", "https://remote.example/outbox");
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: remoteActorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: "Bob",
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/outbox",
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
    vi.mocked(fetchRemoteOutbox).mockResolvedValue([
      rsvpActivity("Accept", "https://remote.example/activities/pulled-rejected", {
        actor: "https://remote.example/users/eve",
      }),
    ]);
    const res = await authedApp(db).request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: remoteActorUri }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 0, total: 1 });
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM remote_event_rsvps").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("rate-limits logs for unknown RSVP verbs during pull-sync", async () => {
    seedLocalEvent(db);
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain, outbox) VALUES (?, ?, ?, ?, ?)")
      .run(remoteActorUri, "bob", "https://remote.example/inbox", "remote.example", "https://remote.example/outbox");
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: remoteActorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: "Bob",
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/outbox",
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.mocked(fetchRemoteOutbox).mockResolvedValue([
      rsvpActivity("Interested", "https://remote.example/activities/pulled-unknown-1"),
      rsvpActivity("Interested", "https://remote.example/activities/pulled-unknown-2"),
    ]);

    let res = await authedApp(db).request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: remoteActorUri }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 0, total: 2 });
    const firstUnknownPullLogs = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("Ignored unknown pulled RSVP activity type"));
    expect(firstUnknownPullLogs).toHaveLength(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    vi.mocked(fetchRemoteOutbox).mockResolvedValue([
      rsvpActivity("Interested", "https://remote.example/activities/pulled-unknown-3"),
    ]);

    res = await authedApp(db).request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: remoteActorUri }),
    });
    expect(res.status).toBe(200);
    const unknownPullLogs = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("Ignored unknown pulled RSVP activity type"));
    expect(unknownPullLogs).toHaveLength(2);
    expect(unknownPullLogs[1]).toContain("suppressed 1 similar logs in last 300s");
  });

  it("applies inbox-equivalent object-form target validation for pulled RSVP activities", async () => {
    seedLocalEvent(db);
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain, outbox) VALUES (?, ?, ?, ?, ?)")
      .run(remoteActorUri, "bob", "https://remote.example/inbox", "remote.example", "https://remote.example/outbox");
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: remoteActorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: "Bob",
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/outbox",
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
    vi.mocked(fetchRemoteOutbox).mockResolvedValue([
      rsvpActivity("Accept", "https://remote.example/activities/pulled-wrong-object-type", {
        object: { type: "Note", id: localEventUrl },
      }),
      rsvpActivity("Accept", "https://remote.example/activities/pulled-wrong-attributed-to", {
        object: { type: "Event", id: localEventUrl, attributedTo: "http://localhost/users/mallory" },
      }),
    ]);

    const res = await authedApp(db).request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: remoteActorUri }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 0, total: 2 });

    const count = db.prepare("SELECT COUNT(*) AS cnt FROM remote_event_rsvps").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("does not count stale pulled RSVP updates as imported", async () => {
    seedLocalEvent(db);
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain, outbox) VALUES (?, ?, ?, ?, ?)")
      .run(remoteActorUri, "bob", "https://remote.example/inbox", "remote.example", "https://remote.example/outbox");
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: remoteActorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: "Bob",
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/outbox",
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
    vi.mocked(fetchRemoteOutbox).mockResolvedValue([
      rsvpActivity("Accept", "https://remote.example/activities/pulled-newer", {
        published: "2026-01-02T00:00:00.000Z",
      }),
      rsvpActivity("Leave", "https://remote.example/activities/pulled-older", {
        published: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    const res = await authedApp(db).request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: remoteActorUri }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 1, total: 2 });

    const row = db.prepare("SELECT status, last_activity_type FROM remote_event_rsvps WHERE event_id = ? AND actor_uri = ?")
      .get("event-1", remoteActorUri) as { status: string; last_activity_type: string };
    expect(row).toEqual({ status: "going", last_activity_type: "Accept" });
  });

  it("normalizes pulled RSVP activity ids like inbox handling", async () => {
    seedLocalEvent(db);
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain, outbox) VALUES (?, ?, ?, ?, ?)")
      .run(remoteActorUri, "bob", "https://remote.example/inbox", "remote.example", "https://remote.example/outbox");
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: remoteActorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: "Bob",
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/outbox",
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

    vi.mocked(fetchRemoteOutbox).mockResolvedValue([
      rsvpActivity("Accept", "   https://remote.example/activities/pulled-trim-me   "),
    ]);
    let res = await authedApp(db).request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: remoteActorUri }),
    });
    expect(res.status).toBe(200);
    let row = db.prepare("SELECT last_activity_id FROM remote_event_rsvps WHERE event_id = ? AND actor_uri = ?")
      .get("event-1", remoteActorUri) as { last_activity_id: string | null };
    expect(row.last_activity_id).toBe("https://remote.example/activities/pulled-trim-me");

    db.prepare("DELETE FROM remote_event_rsvps").run();
    vi.mocked(fetchRemoteOutbox).mockResolvedValue([
      rsvpActivity("Accept", "   "),
    ]);
    res = await authedApp(db).request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: remoteActorUri }),
    });
    expect(res.status).toBe(200);
    row = db.prepare("SELECT last_activity_id FROM remote_event_rsvps WHERE event_id = ? AND actor_uri = ?")
      .get("event-1", remoteActorUri) as { last_activity_id: string | null };
    expect(row.last_activity_id).toBeNull();
  });

  it("falls back to updated when pulled RSVP published is invalid", async () => {
    seedLocalEvent(db);
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain, outbox) VALUES (?, ?, ?, ?, ?)")
      .run(remoteActorUri, "bob", "https://remote.example/inbox", "remote.example", "https://remote.example/outbox");
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: remoteActorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: "Bob",
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/outbox",
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
    vi.mocked(fetchRemoteOutbox).mockResolvedValue([
      rsvpActivity("Accept", "https://remote.example/activities/pulled-invalid-published", {
        published: "",
        updated: "2026-05-03T10:00:00Z",
      }),
    ]);

    const res = await authedApp(db).request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: remoteActorUri }),
    });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT last_activity_published_at FROM remote_event_rsvps WHERE event_id = ? AND actor_uri = ?")
      .get("event-1", remoteActorUri) as { last_activity_published_at: string | null };
    expect(row.last_activity_published_at).toBe("2026-05-03T10:00:00.000Z");
  });

  it("rejects pulled RSVP for local events that are not federation-eligible", async () => {
    seedLocalEvent(db, "private");
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain, outbox) VALUES (?, ?, ?, ?, ?)")
      .run(remoteActorUri, "bob", "https://remote.example/inbox", "remote.example", "https://remote.example/outbox");
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: remoteActorUri,
      type: "Person",
      preferred_username: "bob",
      display_name: "Bob",
      summary: null,
      inbox: "https://remote.example/inbox",
      outbox: "https://remote.example/outbox",
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
    vi.mocked(fetchRemoteOutbox).mockResolvedValue([
      rsvpActivity("Accept", "https://remote.example/activities/pulled-private-target"),
    ]);

    const res = await authedApp(db).request("http://localhost/api/v1/federation/fetch-actor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorUri: remoteActorUri }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, imported: 0, total: 1 });
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM remote_event_rsvps").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });
});
