import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase } from "../src/db.js";
import { getSsrInitialData } from "../src/lib/ssr-data.js";
import { hashTokenSecret } from "../src/lib/token-secrets.js";
import { privateFeedRoutes } from "../src/routes/private-feeds.js";
import { userRoutes } from "../src/routes/users.js";

function seedRemoteActor(db: ReturnType<typeof initDatabase>) {
  db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain, summary) VALUES (?, ?, ?, ?, ?)")
    .run("https://remote.example/users/mallory", "mallory", "https://remote.example/inbox", "remote.example", "Remote actor");
}

function seedRemoteEvent(
  db: ReturnType<typeof initDatabase>,
  values: { uri: string; slug: string; title: string; moderationState: "visible" | "hidden" },
) {
  db.prepare(
    "INSERT INTO remote_events (uri, actor_uri, slug, title, start_date, start_at_utc, timezone_quality, visibility, moderation_state) VALUES (?, ?, ?, ?, ?, ?, 'offset_only', 'public', ?)"
  ).run(
    values.uri,
    "https://remote.example/users/mallory",
    values.slug,
    values.title,
    "2099-06-01",
    `${values.moderationState === "visible" ? "2099-06-01" : "2099-06-02"}T00:00:00.000Z`,
    values.moderationState,
  );
}

function seedFederationBlock(
  db: ReturnType<typeof initDatabase>,
  values: { blockType: "actor" | "domain"; actorUri?: string; domain?: string },
) {
  db.prepare(
    "INSERT INTO federation_blocks (id, block_type, actor_uri, domain, reason, created_by_account_id, is_active) VALUES (?, ?, ?, ?, 'test block', 'admin-1', 1)"
  ).run(
    `${values.blockType}-${values.actorUri || values.domain}`,
    values.blockType,
    values.actorUri || null,
    values.domain || null,
  );
}

function seedFederationTombstone(
  db: ReturnType<typeof initDatabase>,
  values: { objectType: string; objectId: string; expiresAt?: string | null },
) {
  db.prepare(
    "INSERT INTO federation_tombstones (id, object_type, object_id, reason, expires_at) VALUES (?, ?, ?, 'test tombstone', ?)"
  ).run(
    `${values.objectType}:${values.objectId}`,
    values.objectType,
    values.objectId,
    values.expiresAt ?? null,
  );
}

describe("remote readability across profile and feed surfaces", () => {
  it("hides blocked remote events from remote profile APIs and counts", async () => {
    const db = initDatabase(":memory:");
    seedRemoteActor(db);
    seedRemoteEvent(db, {
      uri: "https://remote.example/events/visible-profile",
      slug: "visible-profile",
      title: "Visible Profile Event",
      moderationState: "visible",
    });
    seedRemoteEvent(db, {
      uri: "https://remote.example/events/hidden-profile",
      slug: "hidden-profile",
      title: "Hidden Profile Event",
      moderationState: "hidden",
    });

    const app = new Hono();
    app.route("/api/v1/users", userRoutes(db));

    const profileRes = await app.request("http://localhost/api/v1/users/mallory@remote.example");
    const profileBody = await profileRes.json() as { eventsCount: number };
    expect(profileRes.status).toBe(200);
    expect(profileBody.eventsCount).toBe(1);

    const eventsRes = await app.request("http://localhost/api/v1/users/mallory@remote.example/events");
    const eventsBody = await eventsRes.json() as { events: Array<{ id: string }> };
    expect(eventsRes.status).toBe(200);
    expect(eventsBody.events.map((event) => event.id)).toEqual(["https://remote.example/events/visible-profile"]);
  });

  it("hides blocked remote events from SSR profile and event payloads", () => {
    const db = initDatabase(":memory:");
    seedRemoteActor(db);
    seedRemoteEvent(db, {
      uri: "https://remote.example/events/visible-ssr",
      slug: "visible-ssr",
      title: "Visible SSR Event",
      moderationState: "visible",
    });
    seedRemoteEvent(db, {
      uri: "https://remote.example/events/hidden-ssr",
      slug: "hidden-ssr",
      title: "Hidden SSR Event",
      moderationState: "hidden",
    });

    const profileData = getSsrInitialData(db, "/@mallory@remote.example", null);
    expect(profileData?.kind).toBe("profile");
    if (!profileData || profileData.kind !== "profile") throw new Error("expected profile payload");
    expect((profileData.profile as { eventsCount: number }).eventsCount).toBe(1);
    expect((profileData.events as Array<{ id: string }>).map((event) => event.id)).toEqual(["https://remote.example/events/visible-ssr"]);

    const eventData = getSsrInitialData(db, "/@mallory@remote.example/hidden-ssr", null);
    expect(eventData?.kind).toBe("event");
    if (!eventData || eventData.kind !== "event") throw new Error("expected event payload");
    expect(eventData.event).toBeNull();
  });

  it("hides blocked remote events from private calendar feeds", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("u1", "alice");
    db.prepare("INSERT INTO calendar_feed_tokens (account_id, token) VALUES (?, ?)").run("u1", hashTokenSecret("tok1"));
    seedRemoteActor(db);
    seedRemoteEvent(db, {
      uri: "https://remote.example/events/visible-feed",
      slug: "visible-feed",
      title: "Visible Feed Event",
      moderationState: "visible",
    });
    seedRemoteEvent(db, {
      uri: "https://remote.example/events/hidden-feed",
      slug: "hidden-feed",
      title: "Hidden Feed Event",
      moderationState: "hidden",
    });
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("u1", "https://remote.example/events/visible-feed");
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("u1", "https://remote.example/events/hidden-feed");

    const app = new Hono();
    app.route("/api/v1/private-feeds", privateFeedRoutes(db));

    const res = await app.request("http://localhost/api/v1/private-feeds/calendar.ics?token=tok1");
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("Visible Feed Event");
    expect(text).not.toContain("Hidden Feed Event");
  });

  it("hides remote events for actively blocked actors and domains even when moderation is visible", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("u1", "alice");
    db.prepare("INSERT INTO calendar_feed_tokens (account_id, token) VALUES (?, ?)").run("u1", hashTokenSecret("tok1"));
    seedRemoteActor(db);
    seedRemoteEvent(db, {
      uri: "https://remote.example/events/blocked-actor",
      slug: "blocked-actor",
      title: "Blocked Actor Event",
      moderationState: "visible",
    });
    seedRemoteEvent(db, {
      uri: "https://remote.example/events/blocked-domain",
      slug: "blocked-domain",
      title: "Blocked Domain Event",
      moderationState: "visible",
    });
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain, summary) VALUES (?, ?, ?, ?, ?)")
      .run("https://elsewhere.example/users/eve", "eve", "https://elsewhere.example/inbox", "elsewhere.example", "Elsewhere actor");
    db.prepare(
      "INSERT INTO remote_events (uri, actor_uri, slug, title, start_date, start_at_utc, timezone_quality, visibility, moderation_state) VALUES (?, ?, ?, ?, ?, ?, 'offset_only', 'public', 'visible')"
    ).run(
      "https://elsewhere.example/events/visible",
      "https://elsewhere.example/users/eve",
      "visible",
      "Visible Elsewhere Event",
      "2099-06-03",
      "2099-06-03T00:00:00.000Z",
    );
    seedFederationBlock(db, { blockType: "actor", actorUri: "https://remote.example/users/mallory" });
    seedFederationBlock(db, { blockType: "domain", domain: "remote.example" });
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("u1", "https://remote.example/events/blocked-actor");
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("u1", "https://elsewhere.example/events/visible");

    const userApp = new Hono();
    userApp.route("/api/v1/users", userRoutes(db));

    const profileRes = await userApp.request("http://localhost/api/v1/users/mallory@remote.example");
    const profileBody = await profileRes.json() as { eventsCount: number };
    expect(profileBody.eventsCount).toBe(0);

    const eventsRes = await userApp.request("http://localhost/api/v1/users/mallory@remote.example/events");
    const eventsBody = await eventsRes.json() as { events: Array<{ id: string }> };
    expect(eventsBody.events).toEqual([]);

    const profileData = getSsrInitialData(db, "/@mallory@remote.example", null);
    expect(profileData?.kind).toBe("profile");
    if (!profileData || profileData.kind !== "profile") throw new Error("expected profile payload");
    expect((profileData.profile as { eventsCount: number }).eventsCount).toBe(0);
    expect(profileData.events).toEqual([]);

    const eventData = getSsrInitialData(db, "/@mallory@remote.example/blocked-actor", null);
    expect(eventData?.kind).toBe("event");
    if (!eventData || eventData.kind !== "event") throw new Error("expected event payload");
    expect(eventData.event).toBeNull();

    const feedApp = new Hono();
    feedApp.route("/api/v1/private-feeds", privateFeedRoutes(db));
    const res = await feedApp.request("http://localhost/api/v1/private-feeds/calendar.ics?token=tok1");
    const text = await res.text();
    expect(text).toContain("Visible Elsewhere Event");
    expect(text).not.toContain("Blocked Actor Event");
    expect(text).not.toContain("Blocked Domain Event");
  });

  it("hides tombstoned remote events while ignoring expired tombstones", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("u1", "alice");
    db.prepare("INSERT INTO calendar_feed_tokens (account_id, token) VALUES (?, ?)").run("u1", hashTokenSecret("tok1"));
    seedRemoteActor(db);
    seedRemoteEvent(db, {
      uri: "https://remote.example/events/visible-tombstone",
      slug: "visible-tombstone",
      title: "Visible Tombstone Event",
      moderationState: "visible",
    });
    seedRemoteEvent(db, {
      uri: "https://remote.example/events/hidden-by-tombstone",
      slug: "hidden-by-tombstone",
      title: "Hidden By Tombstone",
      moderationState: "visible",
    });
    seedRemoteEvent(db, {
      uri: "https://remote.example/events/expired-tombstone",
      slug: "expired-tombstone",
      title: "Expired Tombstone Event",
      moderationState: "visible",
    });
    seedFederationTombstone(db, {
      objectType: "remote_event",
      objectId: "https://remote.example/events/hidden-by-tombstone",
    });
    seedFederationTombstone(db, {
      objectType: "remote_event",
      objectId: "https://remote.example/events/expired-tombstone",
      expiresAt: "2000-01-01T00:00:00Z",
    });
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("u1", "https://remote.example/events/visible-tombstone");
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("u1", "https://remote.example/events/hidden-by-tombstone");
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("u1", "https://remote.example/events/expired-tombstone");

    const userApp = new Hono();
    userApp.route("/api/v1/users", userRoutes(db));

    const profileRes = await userApp.request("http://localhost/api/v1/users/mallory@remote.example");
    const profileBody = await profileRes.json() as { eventsCount: number };
    expect(profileBody.eventsCount).toBe(2);

    const eventsRes = await userApp.request("http://localhost/api/v1/users/mallory@remote.example/events");
    const eventsBody = await eventsRes.json() as { events: Array<{ id: string }> };
    expect(eventsBody.events.map((event) => event.id)).toEqual([
      "https://remote.example/events/visible-tombstone",
      "https://remote.example/events/expired-tombstone",
    ]);

    const profileData = getSsrInitialData(db, "/@mallory@remote.example", null);
    expect(profileData?.kind).toBe("profile");
    if (!profileData || profileData.kind !== "profile") throw new Error("expected profile payload");
    expect((profileData.events as Array<{ id: string }>).map((event) => event.id)).toEqual([
      "https://remote.example/events/visible-tombstone",
      "https://remote.example/events/expired-tombstone",
    ]);

    const feedApp = new Hono();
    feedApp.route("/api/v1/private-feeds", privateFeedRoutes(db));
    const feedRes = await feedApp.request("http://localhost/api/v1/private-feeds/calendar.ics?token=tok1");
    const feedText = await feedRes.text();
    expect(feedText).toContain("Visible Tombstone Event");
    expect(feedText).toContain("Expired Tombstone Event");
    expect(feedText).not.toContain("Hidden By Tombstone");
  });

  it("hides tombstoned remote actors from profile APIs and SSR", async () => {
    const db = initDatabase(":memory:");
    seedRemoteActor(db);
    seedRemoteEvent(db, {
      uri: "https://remote.example/events/actor-tombstone",
      slug: "actor-tombstone",
      title: "Actor Tombstone Event",
      moderationState: "visible",
    });
    seedFederationTombstone(db, {
      objectType: "remote_actor",
      objectId: "https://remote.example/users/mallory",
    });

    const app = new Hono();
    app.route("/api/v1/users", userRoutes(db));

    const profileRes = await app.request("http://localhost/api/v1/users/mallory@remote.example");
    expect(profileRes.status).toBe(404);

    const eventsRes = await app.request("http://localhost/api/v1/users/mallory@remote.example/events");
    expect(eventsRes.status).toBe(404);

    const profileData = getSsrInitialData(db, "/@mallory@remote.example", null);
    expect(profileData?.kind).toBe("profile");
    if (!profileData || profileData.kind !== "profile") throw new Error("expected profile payload");
    expect(profileData.profile).toBeNull();
    expect(profileData.events).toEqual([]);
  });
});
