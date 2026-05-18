import { beforeEach, describe, expect, it, vi } from "vitest";
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

const localEventUrl = "http://localhost/events/event-1";
const remoteActorUri = "https://remote.example/users/bob";

function seedLocalEvent(db: DB): void {
  db.prepare("INSERT INTO accounts (id, username, account_type, private_key, public_key) VALUES (?, ?, 'person', ?, ?)")
    .run("local1", "alice", "PRIVATE", "PUBLIC");
  db.prepare(
    `INSERT INTO events (
      id, account_id, title, start_date, start_at_utc, event_timezone, visibility
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("event-1", "local1", "Local Event", "2026-06-01T10:00:00", "2026-06-01T10:00:00.000Z", "UTC", "public");
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
    object: localEventUrl,
    published: "2026-05-01T10:00:00Z",
    ...extra,
  };
}

describe("ActivityPub RSVP federation", () => {
  let db: DB;

  beforeEach(() => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    process.env.BASE_URL = "http://localhost";
    db = initDatabase(":memory:");
    vi.mocked(resolveRemoteActor).mockReset();
    vi.mocked(fetchRemoteOutbox).mockReset();
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

  it("rejects malformed and impersonation-like RSVP payloads without mutating state", async () => {
    seedLocalEvent(db);
    await postInbox(db, rsvpActivity("Accept", "https://remote.example/activities/forged-object-actor", {
      object: { type: "Event", id: localEventUrl, actor: "https://remote.example/users/eve" },
    }));
    await postInbox(db, rsvpActivity("Accept", "https://remote.example/activities/wrong-attributed-to", {
      object: { type: "Event", id: localEventUrl, attributedTo: "http://localhost/users/mallory" },
    }));
    await postInbox(db, rsvpActivity("Accept", "https://remote.example/activities/non-local", {
      object: "https://other.example/events/not-local",
    }));
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM remote_event_rsvps").get() as { cnt: number };
    expect(count.cnt).toBe(0);
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
});
