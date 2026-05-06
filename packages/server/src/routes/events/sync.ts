import type { Hono } from "hono";
import type { DB } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { getLocale, t } from "../../lib/i18n.js";
import { parseJsonBody } from "../../lib/request-body.js";
import { notifyEventUpdated, notifyEventCancelled } from "../../lib/notifications.js";
import { enqueueOgJob } from "../../lib/og-job-queue.js";
import { clearLocalOgImage, generateAndSaveOgImage, isOgEligibleVisibility } from "../og-images.js";
import { uniqueLocalEventSlug } from "../../lib/slugs.js";
import { createSyncBatchApplier, normalizeSyncEvents, reconcileMissingEvents, type ExistingSyncEventRow, type RawSyncEvent } from "../../lib/event-sync.js";

export function registerEventSyncRoutes(router: Hono, db: DB): void {
  router.post("/sync", requireAuth(), async (c) => {
    const user = c.get("user")!;
    type SyncRequestBody = {
      events: {
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
      }[];
    };
    let body: SyncRequestBody;

    const parsed = await parseJsonBody<SyncRequestBody>(c);
    if (parsed instanceof Response) return parsed;
    body = parsed;

    if (!Array.isArray(body.events)) {
      return c.json({ error: t(getLocale(c), "events.events_array_required") }, 400);
    }

    const normalizationResult = normalizeSyncEvents(body.events as RawSyncEvent[]);
    if (!normalizationResult.ok) {
      return c.json({ error: t(getLocale(c), normalizationResult.errorKey) }, 400);
    }
    const syncEvents = normalizationResult.syncEvents;

    const existing = db
      .prepare(
        "SELECT id, slug, external_id, content_hash, title, start_date, end_date, start_at_utc, end_at_utc, event_timezone, all_day, location_name, location_address, url, description, visibility, canceled, missing_since FROM events WHERE account_id = ? AND external_id IS NOT NULL"
      )
      .all(user.id) as ExistingSyncEventRow[];

    const existingByExtId = new Map(existing.map((r) => [r.external_id, r]));
    const incomingExtIds = new Set(syncEvents.map((e) => e.externalId));

    let created = 0;
    let updated = 0;
    let canceled = 0;
    let rotatedOutPast = 0;
    let unchanged = 0;
    const ogEventIdsToGenerate = new Set<string>();
    const ogEventIdsToClear = new Set<string>();

    const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

    const nowIso = new Date().toISOString();
    const missingReconciliation = reconcileMissingEvents(db, {
      existing,
      incomingExtIds,
      nowIso,
    });
    canceled += missingReconciliation.canceled;
    rotatedOutPast += missingReconciliation.rotatedOutPast;

    for (const row of missingReconciliation.notifications) {
      notifyEventCancelled(db, row.id, {
        id: row.id,
        title: row.title,
        slug: row.slug || row.id,
        account: { username: user.username },
        startDate: row.start_date,
        endDate: row.end_date,
        allDay: !!row.all_day,
        location: row.location_name ? { name: row.location_name } : null,
        url: row.url,
      });
    }
    if (missingReconciliation.missingCount > 0) {
      await yieldToEventLoop();
    }

    const BATCH_SIZE = 20;
    const applySyncBatch = createSyncBatchApplier(db);
    for (let i = 0; i < syncEvents.length; i += BATCH_SIZE) {
      const chunk = syncEvents.slice(i, i + BATCH_SIZE);
      const result = applySyncBatch({
        events: chunk,
        existingByExtId,
        accountId: user.id,
        username: user.username,
        ogEventIdsToGenerate,
        ogEventIdsToClear,
        uniqueLocalEventSlug,
        isOgEligibleVisibility,
        notifyEventUpdated: (eventId, event, changes) => notifyEventUpdated(db, eventId, event, changes),
      });
      created += result.created;
      updated += result.updated;
      unchanged += result.unchanged;

      if (i + BATCH_SIZE < syncEvents.length) {
        await yieldToEventLoop();
      }
    }

    for (const eventId of ogEventIdsToGenerate) {
      enqueueOgJob(`local:${eventId}`, async () => {
        try {
          await generateAndSaveOgImage(db, eventId);
        } catch (err) {
          console.error(`[OG] Failed to create OG image for event ${eventId}:`, err);
        }
      });
    }

    for (const eventId of ogEventIdsToClear) {
      enqueueOgJob(`local:${eventId}`, async () => {
        try {
          await clearLocalOgImage(db, eventId);
        } catch (err) {
          console.error(`[OG] Failed to clear OG image for event ${eventId}:`, err);
        }
      });
    }

    return c.json({ ok: true, created, updated, unchanged, canceled, rotatedOutPast, total: syncEvents.length });
  });

  // ─── POST /:id/repost ──────────────────────────────────────────────────
}
