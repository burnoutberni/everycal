/**
 * Integration tests for ActivityPub federation with Mobilizon (events.htu.at).
 *
 * These tests fetch real data from https://events.htu.at/@htubarrierefrei
 * to verify interoperability with Mobilizon instances.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initDatabase, type DB } from "../src/db.js";
import {
  fetchAP,
  resolveRemoteActor,
  fetchRemoteOutbox,
  type RemoteActor,
} from "../src/lib/federation.js";

const ACTOR_URI = "https://events.htu.at/@htubarrierefrei";

describe("Mobilizon federation (events.htu.at)", () => {
  let db: DB;

  beforeAll(() => {
    db = initDatabase(":memory:");
  });

  describe("fetchAP", () => {
    it("fetches a Mobilizon Group actor", async () => {
      const actor = (await fetchAP(ACTOR_URI)) as Record<string, unknown>;
      expect(actor.type).toBe("Group");
      expect(actor.preferredUsername).toBe("htubarrierefrei");
      expect(actor.name).toBeTruthy();
      expect(actor.inbox).toContain("events.htu.at");
      expect(actor.outbox).toContain("events.htu.at");
      expect(actor.publicKey).toBeTruthy();
    });

    it("fetches outbox collection", async () => {
      const outbox = (await fetchAP(
        `${ACTOR_URI}/outbox`
      )) as Record<string, unknown>;
      expect(outbox.type).toBe("OrderedCollection");
      expect(outbox.totalItems).toBeGreaterThan(0);
      expect(outbox.first).toBeTruthy();
    });
  });

  describe("resolveRemoteActor", () => {
    it("resolves and caches a Mobilizon actor", async () => {
      const actor = await resolveRemoteActor(db, ACTOR_URI, true);
      expect(actor).not.toBeNull();
      expect(actor!.type).toBe("Group");
      expect(actor!.preferred_username).toBe("htubarrierefrei");
      expect(actor!.display_name).toContain("Barrierefreiheit");
      expect(actor!.domain).toBe("events.htu.at");
      expect(actor!.inbox).toContain("events.htu.at");
      expect(actor!.outbox).toContain("outbox");
      expect(actor!.shared_inbox).toBe("https://events.htu.at/inbox");
      expect(actor!.public_key_pem).toContain("BEGIN RSA PUBLIC KEY");
    });

    it("returns cached actor on second call", async () => {
      const actor = await resolveRemoteActor(db, ACTOR_URI);
      expect(actor).not.toBeNull();
      expect(actor!.display_name).toContain("Barrierefreiheit");
    });
  });

  describe("fetchRemoteOutbox", () => {
    it("fetches all events with pagination", { timeout: 30000 }, async () => {
      const items = await fetchRemoteOutbox(`${ACTOR_URI}/outbox`, 10);
      expect(items.length).toBeGreaterThan(10); // Should span multiple pages

      // All items should be Create activities with Event objects
      for (const item of items) {
        const activity = item as Record<string, unknown>;
        expect(activity.type).toBe("Create");
        const obj = activity.object as Record<string, unknown>;
        expect(obj.type).toBe("Event");
        expect(obj.name).toBeTruthy();
        expect(obj.startTime).toBeTruthy();
        expect(obj.id).toContain("events.htu.at");
      }
    });
  });

  describe("Mobilizon event parsing", () => {
    let events: Record<string, unknown>[];

    beforeAll(async () => {
      const items = await fetchRemoteOutbox(`${ACTOR_URI}/outbox`, 10);
      events = items.map(
        (item) => (item as Record<string, unknown>).object as Record<string, unknown>
      );
    });

    it("parses event names", () => {
      for (const event of events) {
        expect(typeof event.name).toBe("string");
        expect((event.name as string).length).toBeGreaterThan(0);
      }
    });

    it("parses PostalAddress locations", () => {
      const withLocation = events.filter((e) => e.location);
      expect(withLocation.length).toBeGreaterThan(0);

      for (const event of withLocation) {
        const loc = event.location as Record<string, unknown>;
        expect(loc.type).toBe("Place");
        expect(loc.name).toBeTruthy();
        expect(typeof loc.latitude).toBe("number");
        expect(typeof loc.longitude).toBe("number");

        // Mobilizon uses structured PostalAddress
        if (loc.address && typeof loc.address === "object") {
          const addr = loc.address as Record<string, string>;
          expect(addr.type).toBe("PostalAddress");
          expect(addr.streetAddress || addr.addressLocality).toBeTruthy();
        }
      }
    });

    it("parses tags", () => {
      const withTags = events.filter(
        (e) => (e.tag as unknown[])?.length > 0
      );
      expect(withTags.length).toBeGreaterThan(0);

      for (const event of withTags) {
        const tags = event.tag as Array<Record<string, string>>;
        for (const tag of tags) {
          expect(tag.type).toBe("Hashtag");
          expect(tag.name).toMatch(/^#/);
        }
      }
    });

    it("parses Document attachments (images)", () => {
      const withAttachments = events.filter(
        (e) => (e.attachment as unknown[])?.length > 0
      );
      expect(withAttachments.length).toBeGreaterThan(0);

      for (const event of withAttachments) {
        const attachments = event.attachment as Array<Record<string, unknown>>;
        const images = attachments.filter(
          (a) => a.type === "Image" || a.type === "Document"
        );
        // Mobilizon may also include PropertyValue attachments for accessibility
        const propertyValues = attachments.filter(
          (a) => a.type === "PropertyValue"
        );

        for (const img of images) {
          expect(img.url).toBeTruthy();
          expect(img.mediaType).toMatch(/^image\//);
        }
      }
    });

    it("handles attributedTo pointing to group", () => {
      for (const event of events) {
        // Mobilizon events have attributedTo pointing to the group
        expect(event.attributedTo).toBe(ACTOR_URI);
      }
    });
  });

  describe("store remote events", () => {
    beforeAll(async () => {
      const actor = await resolveRemoteActor(db, ACTOR_URI);
      const items = await fetchRemoteOutbox(actor!.outbox!, 10);

      for (const item of items) {
        const activity = item as Record<string, unknown>;
        const object = activity.object as Record<string, unknown>;
        if (!object || object.type !== "Event") continue;

        const tags = (object.tag as Array<{ name: string }>) || [];
        const tagString = tags
          .map((t) => t.name?.replace(/^#/, ""))
          .filter(Boolean)
          .join(",");

        const loc = object.location as Record<string, unknown> | undefined;
        let locationAddress: string | null = null;
        if (loc?.address) {
          if (typeof loc.address === "string") {
            locationAddress = loc.address;
          } else {
            const addr = loc.address as Record<string, string>;
            locationAddress = [
              addr.streetAddress,
              addr.postalCode,
              addr.addressLocality,
              addr.addressCountry,
            ]
              .filter(Boolean)
              .join(", ");
          }
        }

        const attachments =
          (object.attachment as Array<Record<string, unknown>>) || [];
        const image = attachments.find(
          (a) => a.type === "Image" || a.type === "Document"
        );
        const actorUri =
          (object.attributedTo as string) || (activity.actor as string);

        db.prepare(
          `INSERT INTO remote_events (uri, actor_uri, title, description, start_date, end_date,
            location_name, location_address, location_latitude, location_longitude,
            image_url, image_media_type, image_alt, url, tags, raw_json, published, updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uri) DO UPDATE SET
            title=excluded.title, start_date=excluded.start_date, fetched_at=datetime('now')`
        ).run(
          object.id,
          actorUri,
          object.name,
          (object.content as string) || null,
          object.startTime,
          (object.endTime as string) || null,
          (loc?.name as string) || null,
          locationAddress,
          (loc?.latitude as number) ?? null,
          (loc?.longitude as number) ?? null,
          (image?.url as string) || null,
          (image?.mediaType as string) || null,
          (image?.name as string) || null,
          (object.url as string) || null,
          tagString || null,
          JSON.stringify(object),
          (object.published as string) || null,
          (object.updated as string) || null
        );
      }
    });

    it("stores all events in the database", () => {
      const count = (
        db
          .prepare("SELECT COUNT(*) AS cnt FROM remote_events")
          .get() as { cnt: number }
      ).cnt;
      expect(count).toBeGreaterThan(40);
    });

    it("stores location data correctly", () => {
      const rows = db
        .prepare(
          "SELECT location_name, location_address, location_latitude, location_longitude FROM remote_events WHERE location_name IS NOT NULL LIMIT 5"
        )
        .all() as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);

      for (const row of rows) {
        expect(row.location_name).toBeTruthy();
        expect(row.location_address).toContain("Wien");
        expect(typeof row.location_latitude).toBe("number");
        expect(typeof row.location_longitude).toBe("number");
      }
    });

    it("stores tags correctly", () => {
      const rows = db
        .prepare(
          "SELECT tags FROM remote_events WHERE tags IS NOT NULL LIMIT 5"
        )
        .all() as { tags: string }[];
      expect(rows.length).toBeGreaterThan(0);

      for (const row of rows) {
        const tags = row.tags.split(",");
        expect(tags.length).toBeGreaterThan(0);
        // Tags should not have # prefix (stripped)
        for (const tag of tags) {
          expect(tag).not.toMatch(/^#/);
        }
      }
    });

    it("joins with remote_actors correctly", () => {
      const rows = db
        .prepare(
          `SELECT re.title, ra.display_name, ra.domain
           FROM remote_events re
           JOIN remote_actors ra ON ra.uri = re.actor_uri
           LIMIT 3`
        )
        .all() as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);

      for (const row of rows) {
        expect(row.domain).toBe("events.htu.at");
        expect(row.display_name).toContain("Barrierefreiheit");
      }
    });
  });
});
