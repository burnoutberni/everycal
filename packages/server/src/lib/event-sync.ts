import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import type { DB } from "../db.js";
import { isValidVisibility } from "@everycal/core";
import { isValidIanaTimezone } from "./timezone.js";
import {
  computeMaterialEventChanges,
  deriveCanonicalTemporalFields,
  deriveStoredDatePart,
  normalizeEventWriteInput,
  sanitizeEventWriteFields,
} from "./event-write.js";

export type RawSyncEvent = {
  externalId: string;
  title: string;
  description?: string;
  startDate: string;
  endDate?: string | null;
  eventTimezone: string;
  allDay?: boolean;
  location?: { name: string; address?: string; latitude?: number; longitude?: number; url?: string };
  image?: { url: string; mediaType?: string; alt?: string };
  url?: string;
  tags?: string[];
  visibility?: string;
};

export type SyncEventInput = Omit<RawSyncEvent, "startDate" | "endDate" | "allDay" | "eventTimezone"> & {
  startDate: string;
  endDate: string | null;
  allDay: boolean;
  eventTimezone: string;
};

export type ExistingSyncEventRow = {
  id: string;
  slug: string | null;
  external_id: string;
  content_hash: string | null;
  title: string;
  start_date: string;
  end_date: string | null;
  start_at_utc: string;
  end_at_utc: string | null;
  all_day: number;
  location_name: string | null;
  location_address: string | null;
  event_timezone: string | null;
  url: string | null;
  description: string | null;
  visibility: string;
  canceled: number;
  missing_since: string | null;
};

export function normalizeSyncEvents(events: RawSyncEvent[]): { ok: true; syncEvents: SyncEventInput[] } | { ok: false; errorKey: string } {
  const normalizedSyncTemporalByExternalId = new Map<string, {
    startDate: string;
    endDate: string | null;
    allDay: boolean;
    eventTimezone: string;
  }>();
  const normalizedIncomingEvents: RawSyncEvent[] = [];

  for (const ev of events) {
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
      return { ok: false, errorKey: "events.event_requires_fields" };
    }
    const normalizedTimezone = typeof ev.eventTimezone === "string"
      ? ev.eventTimezone.trim()
      : "";
    if (typeof ev.externalId !== "string"
      || !ev.externalId.trim()
      || typeof ev.title !== "string"
      || !ev.title.trim()
      || typeof ev.startDate !== "string"
      || !ev.startDate.trim()
      || typeof ev.eventTimezone !== "string"
      || !normalizedTimezone
      || !isValidIanaTimezone(normalizedTimezone)) {
      return { ok: false, errorKey: "events.event_requires_fields" };
    }
    if ((ev.endDate !== undefined && ev.endDate !== null && typeof ev.endDate !== "string")
      || (ev.allDay !== undefined && typeof ev.allDay !== "boolean")) {
      return { ok: false, errorKey: "events.invalid_datetime" };
    }
    const normalizedWrite = normalizeEventWriteInput({
      startDate: ev.startDate,
      endDate: ev.endDate,
      eventTimezone: normalizedTimezone,
      allDay: ev.allDay,
      allowDateTimeFields: false,
    });
    if (!normalizedWrite) {
      return { ok: false, errorKey: "events.invalid_datetime" };
    }
    const { startAtUtc, endAtUtc } = deriveCanonicalTemporalFields(normalizedWrite);
    if (!startAtUtc
      || (normalizedWrite.allDay ? !endAtUtc : (normalizedWrite.endValue !== null && !endAtUtc))
      || (endAtUtc && endAtUtc < startAtUtc)) {
      return { ok: false, errorKey: "events.invalid_datetime" };
    }
    const normalizedExternalId = ev.externalId.trim();
    normalizedSyncTemporalByExternalId.set(normalizedExternalId, {
      startDate: normalizedWrite.startValue,
      endDate: normalizedWrite.endValue,
      allDay: normalizedWrite.allDay,
      eventTimezone: normalizedWrite.eventTimezone,
    });
    normalizedIncomingEvents.push({
      ...ev,
      externalId: normalizedExternalId,
      eventTimezone: normalizedWrite.eventTimezone,
    });
  }

  const deduped = [...new Map(normalizedIncomingEvents.map((ev) => [ev.externalId, ev])).values()];

  for (const ev of deduped) {
    sanitizeEventWriteFields(ev as Record<string, unknown>);
    if (typeof ev.title !== "string" || !ev.title.trim()) {
      return { ok: false, errorKey: "events.event_requires_fields" };
    }
  }

  const syncEvents: SyncEventInput[] = [];
  for (const ev of deduped) {
    const normalizedTemporal = normalizedSyncTemporalByExternalId.get(ev.externalId);
    if (!normalizedTemporal) {
      return { ok: false, errorKey: "events.invalid_datetime" };
    }
    syncEvents.push({
      ...ev,
      startDate: normalizedTemporal.startDate,
      endDate: normalizedTemporal.endDate,
      allDay: normalizedTemporal.allDay,
      eventTimezone: normalizedTemporal.eventTimezone,
    });
  }

  return { ok: true, syncEvents };
}

export function reconcileMissingEvents(
  db: DB,
  args: {
    existing: ExistingSyncEventRow[];
    incomingExtIds: Set<string>;
    nowIso: string;
  },
 ): {
  canceled: number;
  rotatedOutPast: number;
  missingCount: number;
  notifications: ExistingSyncEventRow[];
} {
  let canceled = 0;
  let rotatedOutPast = 0;
  const notifications: ExistingSyncEventRow[] = [];

  const missingRows = args.existing.filter((r) => !args.incomingExtIds.has(r.external_id));
  if (missingRows.length === 0) {
    return { canceled, rotatedOutPast, missingCount: 0, notifications };
  }

  const markMissingSeen = db.prepare("UPDATE events SET missing_since = COALESCE(missing_since, datetime('now')) WHERE id = ?");
  const markCanceled = db.prepare("UPDATE events SET canceled = 1, missing_since = datetime('now'), updated_at = datetime('now') WHERE id = ?");
  const clearMissingForPast = db.prepare("UPDATE events SET missing_since = NULL WHERE id = ?");

  const missingBatch = db.transaction((rows: typeof missingRows) => {
    for (const row of rows) {
      if (row.start_at_utc < args.nowIso) {
        clearMissingForPast.run(row.id);
        rotatedOutPast++;
        continue;
      }

      if (!row.missing_since) {
        markMissingSeen.run(row.id);
        continue;
      }

      if (!row.canceled) {
        markCanceled.run(row.id);
        canceled++;
      } else {
        markMissingSeen.run(row.id);
      }
    }
  });

  missingBatch(missingRows);

  for (const row of missingRows) {
    if (row.start_at_utc >= args.nowIso && row.missing_since && !row.canceled) {
      notifications.push(row);
    }
  }

  return { canceled, rotatedOutPast, missingCount: missingRows.length, notifications };
}

function eventHash(ev: SyncEventInput): string {
  const normalizedTags = normalizeTags(ev.tags);
  const data = JSON.stringify([
    ev.title, ev.description || "", ev.startDate, ev.endDate || "", ev.eventTimezone,
    ev.allDay ? 1 : 0, ev.location?.name || "", ev.location?.address || "",
    ev.location?.latitude ?? "", ev.location?.longitude ?? "",
    ev.location?.url || "", ev.image?.url || "", ev.image?.mediaType || "",
    ev.image?.alt || "", ev.url || "", ev.visibility || "public",
    normalizedTags.slice().sort().join(","),
  ]);
  return createHash("sha256").update(data).digest("base64url").slice(0, 22);
}

function normalizeTags(tags?: string[]): string[] {
  if (!tags) return [];
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)));
}

export type ApplySyncBatchArgs = {
  events: SyncEventInput[];
  existingByExtId: Map<string, ExistingSyncEventRow>;
  accountId: string;
  username: string;
  ogEventIdsToGenerate: Set<string>;
  ogEventIdsToClear: Set<string>;
  uniqueLocalEventSlug: (db: DB, accountId: string, title: string, excludeId?: string) => string;
  isOgEligibleVisibility: (visibility: string) => boolean;
  notifyEventUpdated: (eventId: string, event: {
    id: string;
    title: string;
    slug: string;
    account: { username: string };
    startDate: string;
    endDate: string | null;
    allDay: boolean;
    location: { name: string } | null;
    url: string | null;
  }, changes: ReturnType<typeof computeMaterialEventChanges>) => void;
};

export function createSyncBatchApplier(
  db: DB,
): (args: ApplySyncBatchArgs) => { created: number; updated: number; unchanged: number } {
  const insertEvent = db.prepare(
    `INSERT INTO events (id, account_id, created_by_account_id, external_id, slug, title, description, start_date, end_date, all_day, start_at_utc, end_at_utc, event_timezone, start_on, end_on,
      location_name, location_address, location_latitude, location_longitude, location_url,
      image_url, image_media_type, image_alt, url, visibility, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const updateEvent = db.prepare(
    `UPDATE events SET title = ?, slug = ?, description = ?, start_date = ?, end_date = ?, all_day = ?, start_at_utc = ?, end_at_utc = ?, event_timezone = ?, start_on = ?, end_on = ?,
      location_name = ?, location_address = ?, location_latitude = ?, location_longitude = ?, location_url = ?,
      image_url = ?, image_media_type = ?, image_alt = ?, url = ?, visibility = ?,
      content_hash = ?, canceled = 0, missing_since = NULL, updated_at = datetime('now')
     WHERE id = ?`
  );

  const restoreEventState = db.prepare(
    "UPDATE events SET canceled = 0, missing_since = NULL, updated_at = datetime('now') WHERE id = ?"
  );

  const deleteTagsStmt = db.prepare("DELETE FROM event_tags WHERE event_id = ?");
  const insertTagStmt = db.prepare("INSERT INTO event_tags (event_id, tag) VALUES (?, ?)");

  const upsertBatch = db.transaction((args: ApplySyncBatchArgs, counters: { created: number; updated: number; unchanged: number }) => {
    for (const ev of args.events) {
      const visibility = ev.visibility || "public";
      if (!isValidVisibility(visibility)) continue;
      const hash = eventHash(ev);
      const existingRow = args.existingByExtId.get(ev.externalId);

      if (existingRow) {
        if (existingRow.content_hash === hash) {
          if (existingRow.canceled || existingRow.missing_since) {
            restoreEventState.run(existingRow.id);
          }
          counters.unchanged++;
          continue;
        }

        const oldAllDay = !!existingRow.all_day;
        const newAllDay = !!ev.allDay;
        const { startAtUtc: nextStartAtUtc, endAtUtc: nextEndAtUtc } = deriveCanonicalTemporalFields({
          startValue: ev.startDate,
          endValue: ev.endDate ?? null,
          allDay: !!ev.allDay,
          eventTimezone: ev.eventTimezone,
        });
        const changes = computeMaterialEventChanges(
          {
            title: existingRow.title,
            startDate: existingRow.start_date,
            endDate: existingRow.end_date,
            allDay: oldAllDay,
            eventTimezone: existingRow.event_timezone,
            startAtUtc: existingRow.start_at_utc,
            endAtUtc: existingRow.end_at_utc,
            locationName: existingRow.location_name,
            locationAddress: existingRow.location_address,
          },
          {
            title: ev.title,
            startDate: ev.startDate,
            endDate: ev.endDate,
            allDay: newAllDay,
            eventTimezone: ev.eventTimezone,
            startAtUtc: nextStartAtUtc,
            endAtUtc: nextEndAtUtc,
            locationName: ev.location?.name,
            locationAddress: ev.location?.address,
          },
        );

        const evSlug = args.uniqueLocalEventSlug(db, args.accountId, ev.title, existingRow.id);
        const nextStartOn = deriveStoredDatePart(ev.startDate, nextStartAtUtc, {
          allDay: !!ev.allDay,
          eventTimezone: ev.eventTimezone,
        }) || ev.startDate.slice(0, 10);
        const nextEndOn = deriveStoredDatePart(ev.endDate ?? null, nextEndAtUtc, {
          allDay: !!ev.allDay,
          eventTimezone: ev.eventTimezone,
        });
        updateEvent.run(
          ev.title, evSlug, ev.description || null,
          ev.startDate, ev.endDate || null, ev.allDay ? 1 : 0,
          nextStartAtUtc, nextEndAtUtc, ev.eventTimezone, nextStartOn, nextEndOn,
          ev.location?.name || null, ev.location?.address || null,
          ev.location?.latitude ?? null, ev.location?.longitude ?? null,
          ev.location?.url || null,
          ev.image?.url || null, ev.image?.mediaType || null, ev.image?.alt || null,
          ev.url || null, visibility, hash, existingRow.id,
        );

        if (args.isOgEligibleVisibility(visibility)) {
          args.ogEventIdsToGenerate.add(existingRow.id);
        } else {
          args.ogEventIdsToClear.add(existingRow.id);
        }

        deleteTagsStmt.run(existingRow.id);
        for (const tag of normalizeTags(ev.tags)) insertTagStmt.run(existingRow.id, tag);
        if (changes.length > 0) {
          args.notifyEventUpdated(existingRow.id, {
            id: existingRow.id,
            title: ev.title,
            slug: evSlug,
            account: { username: args.username },
            startDate: ev.startDate,
            endDate: ev.endDate || null,
            allDay: ev.allDay ?? false,
            location: ev.location ? { name: ev.location.name } : null,
            url: ev.url || null,
          }, changes);
        }
        counters.updated++;
      } else {
        const id = nanoid(16);
        const evSlug = args.uniqueLocalEventSlug(db, args.accountId, ev.title);
        const { startAtUtc: nextStartAtUtc, endAtUtc: nextEndAtUtc } = deriveCanonicalTemporalFields({
          startValue: ev.startDate,
          endValue: ev.endDate ?? null,
          allDay: !!ev.allDay,
          eventTimezone: ev.eventTimezone,
        });
        const nextStartOn = deriveStoredDatePart(ev.startDate, nextStartAtUtc, {
          allDay: !!ev.allDay,
          eventTimezone: ev.eventTimezone,
        }) || ev.startDate.slice(0, 10);
        const nextEndOn = deriveStoredDatePart(ev.endDate ?? null, nextEndAtUtc, {
          allDay: !!ev.allDay,
          eventTimezone: ev.eventTimezone,
        });
        insertEvent.run(
          id, args.accountId, args.accountId, ev.externalId, evSlug,
          ev.title, ev.description || null,
          ev.startDate, ev.endDate || null, ev.allDay ? 1 : 0,
          nextStartAtUtc, nextEndAtUtc, ev.eventTimezone, nextStartOn, nextEndOn,
          ev.location?.name || null, ev.location?.address || null,
          ev.location?.latitude ?? null, ev.location?.longitude ?? null,
          ev.location?.url || null,
          ev.image?.url || null, ev.image?.mediaType || null, ev.image?.alt || null,
          ev.url || null, visibility, hash,
        );

        if (args.isOgEligibleVisibility(visibility)) {
          args.ogEventIdsToGenerate.add(id);
        }

        for (const tag of normalizeTags(ev.tags)) insertTagStmt.run(id, tag);
        counters.created++;
      }
    }
  });

  return (args: ApplySyncBatchArgs) => {
    const counters = { created: 0, updated: 0, unchanged: 0 };
    upsertBatch(args, counters);
    return counters;
  };
}

export function applySyncBatch(
  db: DB,
  args: ApplySyncBatchArgs,
): { created: number; updated: number; unchanged: number } {
  return createSyncBatchApplier(db)(args);
}
