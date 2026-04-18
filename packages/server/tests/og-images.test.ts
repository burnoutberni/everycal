import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { initDatabase } from "../src/db.js";
import type { DB } from "../src/db.js";

const {
  generateOgImageMock,
  getOgImageFilenameMock,
  validateFederationUrlMock,
  writeFileMock,
  unlinkMock,
  existsSyncMock,
  mkdirSyncMock,
} = vi.hoisted(() => ({
  generateOgImageMock: vi.fn(async () => Buffer.from("og-png")),
  getOgImageFilenameMock: vi.fn((eventId: string) => `${eventId}.png`),
  validateFederationUrlMock: vi.fn(async () => undefined),
  writeFileMock: vi.fn(async () => undefined),
  unlinkMock: vi.fn(async () => undefined),
  existsSyncMock: vi.fn(() => true),
  mkdirSyncMock: vi.fn(),
}));

vi.mock("@everycal/og", () => ({
  generateOgImage: generateOgImageMock,
  getOgImageFilename: getOgImageFilenameMock,
}));

vi.mock("../src/lib/federation.js", () => ({
  validateFederationUrl: validateFederationUrlMock,
}));

vi.mock("node:fs/promises", () => ({
  writeFile: writeFileMock,
  unlink: unlinkMock,
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
}));

import {
  clearLocalOgImage,
  generateAndSaveOgImage,
  generateAndSaveRemoteOgImage,
  clearRemoteOgImage,
  isOgEligibleVisibility,
  isRemoteActivityOgEligible,
} from "../src/routes/og-images.js";

function insertAccount(db: DB, id: string) {
  db.prepare("INSERT INTO accounts (id, username, preferred_language) VALUES (?, ?, ?)")
    .run(id, id, "en");
}

function remoteOgImageUrlForUri(uri: string): string {
  const digest = createHash("sha256").update(uri).digest("hex");
  return `/og-images/remote-${digest}.png?v=100`;
}

describe("generateAndSaveOgImage temporal payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    validateFederationUrlMock.mockResolvedValue(undefined);
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
    expect(validateFederationUrlMock).not.toHaveBeenCalled();

    const row = db.prepare("SELECT og_image_url FROM remote_events WHERE uri = ?").get("https://remote.example/events/1") as {
      og_image_url: string | null;
    };
    expect(row.og_image_url).toBe(og);
  });

  it("skips remote header image when URL validation fails", async () => {
    const db = initDatabase(":memory:");
    validateFederationUrlMock.mockRejectedValueOnce(new Error("Requests to private/internal addresses are not allowed"));
    db.prepare(
      `INSERT INTO remote_events (
        uri, actor_uri, title, start_date, end_date, all_day,
        start_at_utc, end_at_utc, event_timezone, timezone_quality,
        image_url, image_media_type, image_alt,
        fetched_at, canceled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "https://remote.example/events/2",
      "https://remote.example/users/alice",
      "Remote Event With Image",
      "2026-02-15T18:00:00+01:00",
      "2026-02-15T19:00:00+01:00",
      0,
      "2026-02-15T17:00:00.000Z",
      "2026-02-15T18:00:00.000Z",
      "Europe/Vienna",
      "exact_tzid",
      "http://127.0.0.1/internal.png",
      "image/png",
      "Header",
      "2026-02-10T12:00:00.000Z",
      0,
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const og = await generateAndSaveRemoteOgImage(db, "https://remote.example/events/2");

    expect(og).toMatch(/^\/og-images\/remote-[a-f0-9]{64}\.png\?v=\d+$/);
    expect(validateFederationUrlMock).toHaveBeenCalledWith("http://127.0.0.1/internal.png");
    expect(generateOgImageMock).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({
        image: undefined,
      }),
    }));
    expect(warnSpy).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });

  it("clears remote og_image_url and removes image file", async () => {
    const db = initDatabase(":memory:");
    db.prepare(
      `INSERT INTO remote_events (
        uri, actor_uri, title, start_date, all_day,
        start_at_utc, event_timezone, timezone_quality,
        og_image_url, fetched_at, canceled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "https://remote.example/events/cleanup",
      "https://remote.example/users/alice",
      "Remote Event Cleanup",
      "2026-02-15T18:00:00+01:00",
      0,
      "2026-02-15T17:00:00.000Z",
      "Europe/Vienna",
      "exact_tzid",
      remoteOgImageUrlForUri("https://remote.example/events/cleanup"),
      "2026-02-10T12:00:00.000Z",
      0,
    );

    await clearRemoteOgImage(db, "https://remote.example/events/cleanup");

    const row = db.prepare("SELECT og_image_url FROM remote_events WHERE uri = ?").get("https://remote.example/events/cleanup") as {
      og_image_url: string | null;
    };
    expect(row.og_image_url).toBeNull();
    expect(unlinkMock).toHaveBeenCalledOnce();
    expect(unlinkMock.mock.calls[0]?.[0]).toContain(createHash("sha256").update("https://remote.example/events/cleanup").digest("hex"));
  });

  it("clears remote og_image_url even when file is already missing", async () => {
    const db = initDatabase(":memory:");
    unlinkMock.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    db.prepare(
      `INSERT INTO remote_events (
        uri, actor_uri, title, start_date, all_day,
        start_at_utc, event_timezone, timezone_quality,
        og_image_url, fetched_at, canceled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "https://remote.example/events/missing",
      "https://remote.example/users/alice",
      "Remote Event Missing File",
      "2026-02-15T18:00:00+01:00",
      0,
      "2026-02-15T17:00:00.000Z",
      "Europe/Vienna",
      "exact_tzid",
      remoteOgImageUrlForUri("https://remote.example/events/missing"),
      "2026-02-10T12:00:00.000Z",
      0,
    );

    await expect(clearRemoteOgImage(db, "https://remote.example/events/missing")).resolves.toBeUndefined();

    const row = db.prepare("SELECT og_image_url FROM remote_events WHERE uri = ?").get("https://remote.example/events/missing") as {
      og_image_url: string | null;
    };
    expect(row.og_image_url).toBeNull();
  });

  it("clears remote og_image_url but does not remove non-remote filename", async () => {
    const db = initDatabase(":memory:");
    db.prepare(
      `INSERT INTO remote_events (
        uri, actor_uri, title, start_date, all_day,
        start_at_utc, event_timezone, timezone_quality,
        og_image_url, fetched_at, canceled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "https://remote.example/events/poisoned-local",
      "https://remote.example/users/alice",
      "Remote Event Poisoned Local",
      "2026-02-15T18:00:00+01:00",
      0,
      "2026-02-15T17:00:00.000Z",
      "Europe/Vienna",
      "exact_tzid",
      "/og-images/local-cleanup.png?v=100",
      "2026-02-10T12:00:00.000Z",
      0,
    );

    await clearRemoteOgImage(db, "https://remote.example/events/poisoned-local");

    const row = db.prepare("SELECT og_image_url FROM remote_events WHERE uri = ?").get("https://remote.example/events/poisoned-local") as {
      og_image_url: string | null;
    };
    expect(row.og_image_url).toBeNull();
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it("clears remote og_image_url but does not remove mismatched remote filename", async () => {
    const db = initDatabase(":memory:");
    db.prepare(
      `INSERT INTO remote_events (
        uri, actor_uri, title, start_date, all_day,
        start_at_utc, event_timezone, timezone_quality,
        og_image_url, fetched_at, canceled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "https://remote.example/events/poisoned-remote",
      "https://remote.example/users/alice",
      "Remote Event Poisoned Remote",
      "2026-02-15T18:00:00+01:00",
      0,
      "2026-02-15T17:00:00.000Z",
      "Europe/Vienna",
      "exact_tzid",
      remoteOgImageUrlForUri("https://remote.example/events/other"),
      "2026-02-10T12:00:00.000Z",
      0,
    );

    await clearRemoteOgImage(db, "https://remote.example/events/poisoned-remote");

    const row = db.prepare("SELECT og_image_url FROM remote_events WHERE uri = ?").get("https://remote.example/events/poisoned-remote") as {
      og_image_url: string | null;
    };
    expect(row.og_image_url).toBeNull();
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it("clears remote og_image_url but does not remove malformed remote filename", async () => {
    const db = initDatabase(":memory:");
    db.prepare(
      `INSERT INTO remote_events (
        uri, actor_uri, title, start_date, all_day,
        start_at_utc, event_timezone, timezone_quality,
        og_image_url, fetched_at, canceled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "https://remote.example/events/poisoned-malformed",
      "https://remote.example/users/alice",
      "Remote Event Poisoned Malformed",
      "2026-02-15T18:00:00+01:00",
      0,
      "2026-02-15T17:00:00.000Z",
      "Europe/Vienna",
      "exact_tzid",
      "/og-images/remote-123.png?v=100",
      "2026-02-10T12:00:00.000Z",
      0,
    );

    await clearRemoteOgImage(db, "https://remote.example/events/poisoned-malformed");

    const row = db.prepare("SELECT og_image_url FROM remote_events WHERE uri = ?").get("https://remote.example/events/poisoned-malformed") as {
      og_image_url: string | null;
    };
    expect(row.og_image_url).toBeNull();
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it("clears local og_image_url and removes local image file", async () => {
    const db = initDatabase(":memory:");
    insertAccount(db, "u1");
    db.prepare(
      `INSERT INTO events (
        id, account_id, title, start_date, all_day,
        start_at_utc, event_timezone, visibility, og_image_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "local-cleanup",
      "u1",
      "Local Event Cleanup",
      "2026-02-15T18:00:00",
      0,
      "2026-02-15T17:00:00.000Z",
      "Europe/Vienna",
      "public",
      "/og-images/local-cleanup.png?v=100",
    );

    await clearLocalOgImage(db, "local-cleanup");

    const row = db.prepare("SELECT og_image_url FROM events WHERE id = ?").get("local-cleanup") as {
      og_image_url: string | null;
    };
    expect(row.og_image_url).toBeNull();
    expect(unlinkMock).toHaveBeenCalledOnce();
    expect(unlinkMock.mock.calls[0]?.[0]).toContain("local-cleanup.png");
  });

  it("clears local og_image_url even when local image file is already missing", async () => {
    const db = initDatabase(":memory:");
    insertAccount(db, "u1");
    unlinkMock.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    db.prepare(
      `INSERT INTO events (
        id, account_id, title, start_date, all_day,
        start_at_utc, event_timezone, visibility, og_image_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "local-missing",
      "u1",
      "Local Event Missing File",
      "2026-02-15T18:00:00",
      0,
      "2026-02-15T17:00:00.000Z",
      "Europe/Vienna",
      "public",
      "/og-images/local-missing.png?v=100",
    );

    await expect(clearLocalOgImage(db, "local-missing")).resolves.toBeUndefined();

    const row = db.prepare("SELECT og_image_url FROM events WHERE id = ?").get("local-missing") as {
      og_image_url: string | null;
    };
    expect(row.og_image_url).toBeNull();
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

  it("uses union of activity and object recipients", () => {
    expect(isRemoteActivityOgEligible(
      {
        to: ["https://www.w3.org/ns/activitystreams#Public"],
      },
      {
        id: "https://remote.example/events/5",
        type: "Event",
        to: ["https://remote.example/users/alice/followers"],
      },
    )).toBe(true);

    expect(isRemoteActivityOgEligible(
      {
        to: ["https://remote.example/users/alice/followers"],
      },
      {
        id: "https://remote.example/events/6",
        type: "Event",
        cc: ["https://www.w3.org/ns/activitystreams#Public"],
      },
    )).toBe(true);
  });

  it("considers audience, bto, and bcc recipients", () => {
    expect(isRemoteActivityOgEligible(
      {
        audience: ["https://www.w3.org/ns/activitystreams#Public"],
      },
      {
        id: "https://remote.example/events/7",
        type: "Event",
      },
    )).toBe(true);

    expect(isRemoteActivityOgEligible(
      {
        bto: ["https://www.w3.org/ns/activitystreams#Public"],
      },
      {
        id: "https://remote.example/events/8",
        type: "Event",
      },
    )).toBe(true);

    expect(isRemoteActivityOgEligible(
      {
        to: ["https://remote.example/users/alice/followers"],
      },
      {
        id: "https://remote.example/events/9",
        type: "Event",
        bcc: ["https://www.w3.org/ns/activitystreams#Public"],
      },
    )).toBe(true);
  });
});
