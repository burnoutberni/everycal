import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../src/db.js";
import type { DB } from "../src/db.js";

const {
  generateOgImageMock,
  getOgImageFilenameMock,
  writeFileMock,
  existsSyncMock,
  mkdirSyncMock,
} = vi.hoisted(() => ({
  generateOgImageMock: vi.fn(async () => Buffer.from("og-png")),
  getOgImageFilenameMock: vi.fn((eventId: string) => `${eventId}.png`),
  writeFileMock: vi.fn(async () => undefined),
  existsSyncMock: vi.fn(() => true),
  mkdirSyncMock: vi.fn(),
}));

vi.mock("@everycal/og", () => ({
  generateOgImage: generateOgImageMock,
  getOgImageFilename: getOgImageFilenameMock,
}));

vi.mock("node:fs/promises", () => ({
  writeFile: writeFileMock,
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
}));

import {
  generateAndSaveOgImage,
  generateAndSaveRemoteOgImage,
  isOgEligibleVisibility,
  isRemoteActivityOgEligible,
} from "../src/routes/og-images.js";

function insertAccount(db: DB, id: string) {
  db.prepare("INSERT INTO accounts (id, username, preferred_language) VALUES (?, ?, ?)")
    .run(id, id, "en");
}

describe("generateAndSaveOgImage temporal payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes canonical UTC instants for timed events", async () => {
    const db = initDatabase(":memory:");
    insertAccount(db, "u1");
    db.prepare(
      `INSERT INTO events (id, account_id, title, start_date, end_date, all_day, start_at_utc, end_at_utc, event_timezone, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "e1",
      "u1",
      "Timed Event",
      "2026-02-15T18:00:00",
      "2026-02-15T19:30:00",
      0,
      "2026-02-15T17:00:00.000Z",
      "2026-02-15T18:30:00.000Z",
      "Europe/Vienna",
      "public"
    );

    await generateAndSaveOgImage(db, "e1");

    expect(generateOgImageMock).toHaveBeenCalledOnce();
    expect(generateOgImageMock).toHaveBeenCalledWith(expect.objectContaining({
      locale: "en",
      event: expect.objectContaining({
        allDay: false,
        startDate: "2026-02-15T17:00:00.000Z",
        endDate: "2026-02-15T18:30:00.000Z",
        startAtUtc: "2026-02-15T17:00:00.000Z",
        endAtUtc: "2026-02-15T18:30:00.000Z",
        eventTimezone: "Europe/Vienna",
      }),
    }));
  });

  it("throws when timed event has end_date without end_at_utc", async () => {
    const db = initDatabase(":memory:");
    insertAccount(db, "u1");
    db.prepare(
      `INSERT INTO events (id, account_id, title, start_date, end_date, all_day, start_at_utc, end_at_utc, event_timezone, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "e2",
      "u1",
      "Broken Timed Event",
      "2026-02-15T18:00:00",
      "2026-02-15T19:30:00",
      0,
      "2026-02-15T17:00:00.000Z",
      null,
      "Europe/Vienna",
      "public"
    );

    await expect(generateAndSaveOgImage(db, "e2"))
      .rejects
      .toThrow("missing end_at_utc");
  });

  it("keeps all-day date payloads and includes timezone", async () => {
    const db = initDatabase(":memory:");
    insertAccount(db, "u1");
    db.prepare(
      `INSERT INTO events (id, account_id, title, start_date, end_date, all_day, start_at_utc, end_at_utc, event_timezone, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "e3",
      "u1",
      "All Day Event",
      "2026-02-15",
      "2026-02-16",
      1,
      "2026-02-15T00:00:00.000Z",
      "2026-02-16T00:00:00.000Z",
      "Europe/Vienna",
      "public"
    );

    await generateAndSaveOgImage(db, "e3");

    expect(generateOgImageMock).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({
        allDay: true,
        startDate: "2026-02-15",
        endDate: "2026-02-16",
        startAtUtc: "2026-02-15T00:00:00.000Z",
        eventTimezone: "Europe/Vienna",
      }),
    }));
  });

  it("skips local OG generation for private events", async () => {
    const db = initDatabase(":memory:");
    insertAccount(db, "u1");
    db.prepare(
      `INSERT INTO events (id, account_id, title, start_date, all_day, start_at_utc, event_timezone, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "e-private",
      "u1",
      "Private Event",
      "2026-02-15T18:00:00",
      0,
      "2026-02-15T17:00:00.000Z",
      "Europe/Vienna",
      "private"
    );

    const og = await generateAndSaveOgImage(db, "e-private");

    expect(og).toBeNull();
    expect(generateOgImageMock).not.toHaveBeenCalled();
  });

  it("generates and stores OG image for remote events", async () => {
    const db = initDatabase(":memory:");
    db.prepare(
      `INSERT INTO remote_events (
        uri, actor_uri, title, start_date, end_date, all_day,
        start_at_utc, end_at_utc, event_timezone, timezone_quality,
        fetched_at, canceled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "https://remote.example/events/1",
      "https://remote.example/users/alice",
      "Remote Event",
      "2026-02-15T18:00:00+01:00",
      "2026-02-15T19:00:00+01:00",
      0,
      "2026-02-15T17:00:00.000Z",
      "2026-02-15T18:00:00.000Z",
      "Europe/Vienna",
      "exact_tzid",
      "2026-02-10T12:00:00.000Z",
      0,
    );

    const og = await generateAndSaveRemoteOgImage(db, "https://remote.example/events/1");

    expect(og).toMatch(/^\/og-images\/remote-[a-f0-9]{64}\.png\?v=\d+$/);
    expect(generateOgImageMock).toHaveBeenCalledOnce();

    const row = db.prepare("SELECT og_image_url FROM remote_events WHERE uri = ?").get("https://remote.example/events/1") as {
      og_image_url: string | null;
    };
    expect(row.og_image_url).toBe(og);
  });
});

describe("OG eligibility helpers", () => {
  it("recognizes eligible visibilities", () => {
    expect(isOgEligibleVisibility("public")).toBe(true);
    expect(isOgEligibleVisibility("unlisted")).toBe(true);
    expect(isOgEligibleVisibility("followers_only")).toBe(false);
    expect(isOgEligibleVisibility("private")).toBe(false);
  });

  it("recognizes remote public and unlisted recipients", () => {
    expect(isRemoteActivityOgEligible(
      { to: ["https://www.w3.org/ns/activitystreams#Public"] },
      { id: "https://remote.example/events/2", type: "Event" },
    )).toBe(true);

    expect(isRemoteActivityOgEligible(
      { cc: ["https://www.w3.org/ns/activitystreams#Public"] },
      { id: "https://remote.example/events/3", type: "Event" },
    )).toBe(true);

    expect(isRemoteActivityOgEligible(
      { to: ["https://remote.example/users/alice/followers"] },
      { id: "https://remote.example/events/4", type: "Event" },
    )).toBe(false);
  });
});
