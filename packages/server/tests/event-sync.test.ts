import { describe, expect, it, vi } from "vitest";
import { initDatabase } from "../src/db.js";
import {
  applySyncBatch,
  normalizeSyncEvents,
  reconcileMissingEvents,
  type ExistingSyncEventRow,
  type RawSyncEvent,
  type SyncEventInput,
} from "../src/lib/event-sync.js";

function makeDb() {
  const db = initDatabase(":memory:");
  db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("u1", "alice");
  return db;
}

function readExisting(db: ReturnType<typeof makeDb>): ExistingSyncEventRow[] {
  return db.prepare(
    "SELECT id, slug, external_id, content_hash, title, start_date, end_date, start_at_utc, end_at_utc, event_timezone, all_day, location_name, location_address, url, description, visibility, canceled, missing_since FROM events WHERE account_id = ? AND external_id IS NOT NULL"
  ).all("u1") as ExistingSyncEventRow[];
}

describe("normalizeSyncEvents", () => {
  it("validates, sanitizes, canonicalizes, and dedupes by externalId", () => {
    const input: RawSyncEvent[] = [
      {
        externalId: " ext-1 ",
        title: "First",
        startDate: "2026-06-01",
        eventTimezone: " UTC ",
        allDay: true,
        tags: ["<b>a</b>", "   ", "two"],
      },
      {
        externalId: "ext-1",
        title: "Second wins",
        startDate: "2026-06-02",
        eventTimezone: "UTC",
        allDay: true,
      },
    ];

    const result = normalizeSyncEvents(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.syncEvents).toHaveLength(1);
    expect(result.syncEvents[0]).toMatchObject({
      externalId: "ext-1",
      title: "Second wins",
      startDate: "2026-06-02",
      endDate: null,
      allDay: true,
      eventTimezone: "UTC",
    });
  });

  it("returns expected error key for invalid timezone", () => {
    const result = normalizeSyncEvents([
      {
        externalId: "x",
        title: "Bad",
        startDate: "2026-01-01",
        eventTimezone: "Not/AZone",
      },
    ]);

    expect(result).toEqual({ ok: false, errorKey: "events.event_requires_fields" });
  });

  it("accepts null endDate values", () => {
    const input: RawSyncEvent[] = [
      {
        externalId: "ext-null-end",
        title: "No explicit end",
        startDate: "2026-01-01",
        endDate: null,
        eventTimezone: "UTC",
        allDay: true,
      },
    ];

    const result = normalizeSyncEvents(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.syncEvents[0]?.endDate).toBeNull();
  });
});

describe("reconcileMissingEvents", () => {
  it("marks first missing as seen, second missing as canceled, and past as rotated out", () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, external_id, slug, title, start_date, all_day, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("future-first", "u1", "u1", "future-first", "future-first", "Future First", "2026-12-01", 1, "2026-12-01T00:00:00.000Z", "UTC", "public");
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, external_id, slug, title, start_date, all_day, start_at_utc, event_timezone, visibility, missing_since) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    ).run("future-second", "u1", "u1", "future-second", "future-second", "Future Second", "2026-12-02", 1, "2026-12-02T00:00:00.000Z", "UTC", "public");
    db.prepare(
      "INSERT INTO events (id, account_id, created_by_account_id, external_id, slug, title, start_date, all_day, start_at_utc, event_timezone, visibility, missing_since) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    ).run("past", "u1", "u1", "past", "past", "Past", "2025-01-01", 1, "2025-01-01T00:00:00.000Z", "UTC", "public");

    const existing = readExisting(db);
    const result = reconcileMissingEvents(db, {
      existing,
      incomingExtIds: new Set<string>(),
      nowIso: "2026-06-01T00:00:00.000Z",
    });

    expect(result.canceled).toBe(1);
    expect(result.rotatedOutPast).toBe(1);
    expect(result.missingCount).toBe(3);
    expect(result.notifications.map((r) => r.id)).toEqual(["future-second"]);
  });
});

describe("applySyncBatch", () => {
  it("creates, updates, and marks unchanged while preserving tag + OG behavior", () => {
    const db = makeDb();
    const slugger = vi.fn((_: unknown, __: string, title: string, excludeId?: string) =>
      `${title.toLowerCase().replace(/\s+/g, "-")}${excludeId ? "-updated" : ""}`,
    );
    const notifyUpdated = vi.fn();
    const ogGenerate = new Set<string>();
    const ogClear = new Set<string>();

    const seed: SyncEventInput = {
      externalId: "ext-1",
      title: "Seed",
      description: "A",
      startDate: "2026-06-10",
      endDate: null,
      eventTimezone: "UTC",
      allDay: true,
      tags: ["  music  ", "   "],
      visibility: "public",
    };

    const first = applySyncBatch(db, {
      events: [seed],
      existingByExtId: new Map(),
      accountId: "u1",
      username: "alice",
      ogEventIdsToGenerate: ogGenerate,
      ogEventIdsToClear: ogClear,
      uniqueLocalEventSlug: slugger,
      isOgEligibleVisibility: (v) => v === "public" || v === "unlisted",
      notifyEventUpdated: notifyUpdated,
    });
    expect(first).toEqual({ created: 1, updated: 0, unchanged: 0 });

    const existingByExtId = new Map(readExisting(db).map((row) => [row.external_id, row]));
    const second = applySyncBatch(db, {
      events: [{ ...seed, title: "Seed updated", tags: [" art ", "   "], visibility: "followers_only" }],
      existingByExtId,
      accountId: "u1",
      username: "alice",
      ogEventIdsToGenerate: ogGenerate,
      ogEventIdsToClear: ogClear,
      uniqueLocalEventSlug: slugger,
      isOgEligibleVisibility: (v) => v === "public" || v === "unlisted",
      notifyEventUpdated: notifyUpdated,
    });
    expect(second).toEqual({ created: 0, updated: 1, unchanged: 0 });

    const existingAfterUpdate = new Map(readExisting(db).map((row) => [row.external_id, row]));
    const third = applySyncBatch(db, {
      events: [{ ...seed, title: "Seed updated", tags: ["  art  ", "   "], visibility: "followers_only" }],
      existingByExtId: existingAfterUpdate,
      accountId: "u1",
      username: "alice",
      ogEventIdsToGenerate: ogGenerate,
      ogEventIdsToClear: ogClear,
      uniqueLocalEventSlug: slugger,
      isOgEligibleVisibility: (v) => v === "public" || v === "unlisted",
      notifyEventUpdated: notifyUpdated,
    });
    expect(third).toEqual({ created: 0, updated: 0, unchanged: 1 });

    expect(notifyUpdated).toHaveBeenCalledTimes(1);
    expect(ogGenerate.size).toBeGreaterThan(0);
    expect(ogClear.size).toBe(1);

    const row = db.prepare("SELECT title, visibility FROM events WHERE external_id = ?").get("ext-1") as { title: string; visibility: string };
    const tags = db.prepare("SELECT tag FROM event_tags WHERE event_id = (SELECT id FROM events WHERE external_id = ?)").all("ext-1") as Array<{ tag: string }>;
    expect(row).toEqual({ title: "Seed updated", visibility: "followers_only" });
    expect(tags.map((t) => t.tag)).toEqual(["art"]);
  });

  it("treats canonical-equivalent tags as unchanged", () => {
    const db = makeDb();
    const slugger = vi.fn((_: unknown, __: string, title: string, excludeId?: string) =>
      `${title.toLowerCase().replace(/\s+/g, "-")}${excludeId ? "-updated" : ""}`,
    );
    const notifyUpdated = vi.fn();
    const ogGenerate = new Set<string>();
    const ogClear = new Set<string>();

    const first = applySyncBatch(db, {
      events: [{
        externalId: "ext-canonical-tags",
        title: "Canonical tags",
        startDate: "2026-07-01",
        endDate: null,
        eventTimezone: "UTC",
        allDay: true,
        visibility: "public",
        tags: ["two", " one ", "", "   "],
      }],
      existingByExtId: new Map(),
      accountId: "u1",
      username: "alice",
      ogEventIdsToGenerate: ogGenerate,
      ogEventIdsToClear: ogClear,
      uniqueLocalEventSlug: slugger,
      isOgEligibleVisibility: (v) => v === "public" || v === "unlisted",
      notifyEventUpdated: notifyUpdated,
    });
    expect(first).toEqual({ created: 1, updated: 0, unchanged: 0 });

    const existingByExtId = new Map(readExisting(db).map((row) => [row.external_id, row]));
    const second = applySyncBatch(db, {
      events: [{
        externalId: "ext-canonical-tags",
        title: "Canonical tags",
        startDate: "2026-07-01",
        endDate: null,
        eventTimezone: "UTC",
        allDay: true,
        visibility: "public",
        tags: ["one", "two"],
      }],
      existingByExtId,
      accountId: "u1",
      username: "alice",
      ogEventIdsToGenerate: ogGenerate,
      ogEventIdsToClear: ogClear,
      uniqueLocalEventSlug: slugger,
      isOgEligibleVisibility: (v) => v === "public" || v === "unlisted",
      notifyEventUpdated: notifyUpdated,
    });

    expect(second).toEqual({ created: 0, updated: 0, unchanged: 1 });
    expect(notifyUpdated).not.toHaveBeenCalled();
  });

  it("dedupes duplicate tags before insert", () => {
    const db = makeDb();
    const slugger = vi.fn((_: unknown, __: string, title: string) => title.toLowerCase().replace(/\s+/g, "-"));

    const result = applySyncBatch(db, {
      events: [{
        externalId: "ext-dup-tags",
        title: "Duplicate tags",
        startDate: "2026-07-10",
        endDate: null,
        eventTimezone: "UTC",
        allDay: true,
        visibility: "public",
        tags: ["art", " art ", "", "  ", "music", "music"],
      }],
      existingByExtId: new Map(),
      accountId: "u1",
      username: "alice",
      ogEventIdsToGenerate: new Set<string>(),
      ogEventIdsToClear: new Set<string>(),
      uniqueLocalEventSlug: slugger,
      isOgEligibleVisibility: (v) => v === "public" || v === "unlisted",
      notifyEventUpdated: vi.fn(),
    });

    expect(result).toEqual({ created: 1, updated: 0, unchanged: 0 });
    const tags = db.prepare(
      "SELECT tag FROM event_tags WHERE event_id = (SELECT id FROM events WHERE external_id = ?) ORDER BY tag"
    ).all("ext-dup-tags") as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toEqual(["art", "music"]);
  });
});
