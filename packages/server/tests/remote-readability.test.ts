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
});
