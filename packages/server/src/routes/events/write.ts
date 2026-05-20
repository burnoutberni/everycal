import type { Hono } from "hono";
import { nanoid } from "nanoid";
import type { DB } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { deliverToFollowers, normalizeEventVisibility, visibilityToActivityPubAddressing } from "../../lib/federation.js";
import { notifyEventUpdated, notifyEventCancelled } from "../../lib/notifications.js";
import { isValidVisibility, type EventVisibility } from "@everycal/core";
import { getLocale, t } from "../../lib/i18n.js";
import { parseJsonBody } from "../../lib/request-body.js";
import { clearLocalOgImage, generateAndSaveOgImage, isOgEligibleVisibility } from "../og-images.js";
import { canManageIdentityEvents } from "../../lib/identities.js";
import { uniqueLocalEventSlug } from "../../lib/slugs.js";
import { isValidIanaTimezone } from "../../lib/timezone.js";
import { AP_CONTEXT, EVERYCAL_CONTEXT, buildApEventObject } from "../../lib/activitypub-event.js";
import { computeMaterialEventChanges, deriveCanonicalTemporalFields, deriveStoredDatePart, normalizePartialUpdateTemporalFields, normalizeEventWriteInput, sanitizeEventWriteFields } from "../../lib/event-write.js";
import { buildActorUrl, buildEventUrl, buildUrl, getBaseUrl } from "../../lib/base-url.js";
import type { EventRouteContext } from "./context.js";

export function registerEventWriteRoutes(router: Hono, db: DB, context: EventRouteContext): void {
  const { readLocalEventById, saveTags, replaceTags } = context;
  router.post("/", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const parsed = await parseJsonBody<{
      title: string;
      description?: string;
      startDate: string;
      endDate?: string;
      startDateTime?: string | null;
      endDateTime?: string;
      eventTimezone?: string;
      allDay?: boolean;
      location?: {
        name: string;
        address?: string;
        latitude?: number;
        longitude?: number;
        url?: string;
      };
      image?: { url: string; mediaType?: string; alt?: string; attribution?: Record<string, unknown> };
      url?: string;
      tags?: string[];
      visibility?: string;
      postAsAccountId?: string;
    }>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed;

    sanitizeEventWriteFields(body as Record<string, unknown>);

    const startDateInput = (typeof body.startDateTime === "string"
      ? body.startDateTime.trim()
      : "") || (typeof body.startDate === "string" ? body.startDate.trim() : "");
    const eventTimezone = typeof body.eventTimezone === "string"
      ? body.eventTimezone.trim()
      : "";
    if (typeof body.title !== "string" || !body.title || !startDateInput) {
      return c.json({ error: t(getLocale(c), "events.title_startdate_required") }, 400);
    }
    if (!eventTimezone || !isValidIanaTimezone(eventTimezone)) {
      return c.json({ error: t(getLocale(c), "events.invalid_timezone") }, 400);
    }

    const postAsAccountId = body.postAsAccountId || user.id;
    const postingAccount = db
      .prepare("SELECT id, username, account_type, is_bot, discoverable, default_event_visibility FROM accounts WHERE id = ?")
      .get(postAsAccountId) as
      | {
          id: string;
          username: string;
          account_type: string;
          is_bot: number;
          discoverable: number;
          default_event_visibility: EventVisibility;
        }
      | undefined;
    if (!postingAccount) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);

    if (postAsAccountId !== user.id) {
      if (postingAccount.account_type !== "identity") {
        return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
      }
      if (!canManageIdentityEvents(db, postingAccount.id, user.id, "editor")) {
        return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
      }
    }

    const id = nanoid(16);
    const slug = uniqueLocalEventSlug(db, postingAccount.id, body.title);

    const fallbackVisibility: EventVisibility = postingAccount.is_bot || postingAccount.discoverable ? "public" : "private";
    const defaultVisibility = isValidVisibility(postingAccount.default_event_visibility)
      ? postingAccount.default_event_visibility
      : fallbackVisibility;
    const visibility = body.visibility || defaultVisibility;

    if (!isValidVisibility(visibility)) {
      return c.json({ error: t(getLocale(c), "events.invalid_visibility") }, 400);
    }

    const imageAttributionJson = body.image?.attribution
      ? JSON.stringify(body.image.attribution)
      : null;
    const normalizedWrite = normalizeEventWriteInput({
      startDate: body.startDate,
      startDateTime: body.startDateTime,
      endDate: body.endDate,
      endDateTime: body.endDateTime,
      eventTimezone,
      allDay: body.allDay,
      allowDateTimeFields: true,
    });
    if (!normalizedWrite) {
      return c.json({ error: t(getLocale(c), "events.invalid_datetime") }, 400);
    }
    const { startAtUtc, endAtUtc, startOn, endOn } = deriveCanonicalTemporalFields(normalizedWrite);
    if (!startAtUtc) {
      return c.json({ error: t(getLocale(c), "events.invalid_datetime") }, 400);
    }
    const startDateValue = normalizedWrite.startValue;
    const endDateValue = normalizedWrite.endValue;
    if ((normalizedWrite.allDay || endDateValue !== null) && !endAtUtc) {
      return c.json({ error: t(getLocale(c), "events.invalid_datetime") }, 400);
    }
    if (endAtUtc && endAtUtc < startAtUtc) {
      return c.json({ error: t(getLocale(c), "events.invalid_datetime") }, 400);
    }
    db.prepare(
      `INSERT INTO events (id, account_id, created_by_account_id, slug, title, description, start_date, end_date, all_day,
        start_at_utc, end_at_utc, event_timezone, start_on, end_on,
        location_name, location_address, location_latitude, location_longitude, location_url,
        image_url, image_media_type, image_alt, image_attribution, url, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, postingAccount.id, user.id, slug, body.title, body.description || null,
      startDateValue, endDateValue, normalizedWrite.allDay ? 1 : 0,
      startAtUtc,
      endAtUtc,
      eventTimezone,
      startOn,
      endOn,
      body.location?.name || null, body.location?.address || null,
      body.location?.latitude ?? null, body.location?.longitude ?? null,
      body.location?.url || null,
      body.image?.url || null, body.image?.mediaType || null,
      body.image?.alt || null, imageAttributionJson,
      body.url || null, visibility,
    );

    if (body.tags && body.tags.length > 0) saveTags(id, body.tags);

    // Creator is going by default
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run(user.id, id);

    // Deliver Create activity to remote followers
    if (visibility !== "private") {
      const baseUrl = getBaseUrl();
      const actorUrl = buildActorUrl(postingAccount.username, baseUrl);
      const publishedAt = new Date().toISOString();
      const addressing = visibilityToActivityPubAddressing(visibility, actorUrl);
      const createActivity = {
        "@context": [AP_CONTEXT, EVERYCAL_CONTEXT],
        id: buildUrl(baseUrl, "events", id, "activity"),
        type: "Create",
        actor: actorUrl,
        published: publishedAt,
        ...addressing,
        object: buildApEventObject({
          id: buildUrl(baseUrl, "events", id),
          name: body.title,
          attributedTo: actorUrl,
          ...addressing,
          allDay: !!body.allDay,
          startDate: startDateValue,
          endDate: endDateValue || undefined,
          startAtUtc,
          endAtUtc,
          content: body.description || undefined,
          eventTimezone,
          url: buildEventUrl(postingAccount.username, slug, null, baseUrl),
          published: publishedAt,
          updated: publishedAt,
        }),
      };
      deliverToFollowers(db, postingAccount.id, createActivity).catch(() => {});
    }

    const response = readLocalEventById(id);
    if (!response) return c.json({ error: t(getLocale(c), "events.event_not_found_after_create") }, 500);
    response.rsvpStatus = "going";

    if (isOgEligibleVisibility(visibility)) {
      void generateAndSaveOgImage(db, id)
        .catch((err) => console.error(`[OG] Failed to create OG image for event ${id}:`, err));
    }

    return c.json(response, 201);
  });

  // ─── PUT /:id — update event ───────────────────────────────────────────

  router.put("/:id", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");

    const existing = db
      .prepare("SELECT account_id, visibility, title, start_date, end_date, all_day, location_name, location_address, event_timezone FROM events WHERE id = ?")
      .get(id) as {
      account_id: string;
      visibility: string;
      title: string;
      start_date: string;
      end_date: string | null;
      all_day: number;
      location_name: string | null;
      location_address: string | null;
      event_timezone: string | null;
    } | undefined;
    if (!existing) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);
    if (!canManageIdentityEvents(db, existing.account_id, user.id, "editor")) {
      return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
    }

    const parsed = await parseJsonBody<{
      title?: string;
      description?: string;
      startDate?: string;
      startDateTime?: string | null;
      endDate?: string | null;
      endDateTime?: string | null;
      eventTimezone?: string;
      allDay?: boolean;
      location?: { name: string; address?: string; latitude?: number; longitude?: number; url?: string } | null;
      image?: { url: string; mediaType?: string; alt?: string; attribution?: Record<string, unknown> } | null;
      url?: string | null;
      tags?: string[];
      visibility?: string;
    }>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed;

    sanitizeEventWriteFields(body as Record<string, unknown>);

    if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim())) {
      return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
    }

    const fields: string[] = [];
    const values: unknown[] = [];

    if (body.title !== undefined) {
      fields.push("title = ?"); values.push(body.title);
    }
    if (body.description !== undefined) { fields.push("description = ?"); values.push(body.description || null); }
    const temporal = normalizePartialUpdateTemporalFields({
      startDate: body.startDate,
      startDateTime: body.startDateTime,
      endDate: body.endDate,
      endDateTime: body.endDateTime,
      eventTimezone: body.eventTimezone,
      allDay: body.allDay,
      existingStart: existing.start_date,
      existingEnd: existing.end_date,
      existingAllDay: !!existing.all_day,
      existingTimezoneRaw: existing.event_timezone,
    });
    if (!temporal.ok) {
      const key = temporal.error === "invalid_datetime" ? "events.invalid_datetime" : "common.requestFailed";
      return c.json({ error: t(getLocale(c), key) }, 400);
    }
    const {
      nextStart,
      nextEnd,
      nextTimezone,
      nextAllDay,
      existingTimezone,
      startForUtc,
      endForUtc,
      nextStartAtUtc,
      nextEndAtUtc,
      tzForConvert,
    } = temporal.value;
    if (nextStart !== undefined) { fields.push("start_date = ?"); values.push(nextStart); }
    if (nextEnd !== undefined) { fields.push("end_date = ?"); values.push(nextEnd); }
    if (nextTimezone !== undefined) {
      fields.push("event_timezone = ?"); values.push(nextTimezone);
    } else if (existingTimezone !== existing.event_timezone) {
      fields.push("event_timezone = ?"); values.push(existingTimezone);
    }
    if (startForUtc !== undefined) {
      fields.push("start_at_utc = ?");
      values.push(nextStartAtUtc);
      const startForDateParts = nextStart ?? existing.start_date;
      fields.push("start_on = ?");
      values.push(
        deriveStoredDatePart(startForDateParts, nextStartAtUtc, {
          allDay: nextAllDay,
          eventTimezone: tzForConvert,
        }) || startForDateParts.slice(0, 10),
      );
    }
    if (endForUtc !== undefined) {
      fields.push("end_at_utc = ?");
      values.push(endForUtc === null && !nextAllDay ? null : nextEndAtUtc);
      const endForDateParts = nextEnd !== undefined ? nextEnd : existing.end_date;
      fields.push("end_on = ?");
      values.push(deriveStoredDatePart(endForDateParts, nextEndAtUtc, {
        allDay: nextAllDay,
        eventTimezone: tzForConvert,
      }));
    }
    if (body.allDay !== undefined) { fields.push("all_day = ?"); values.push(body.allDay ? 1 : 0); }
    if (body.visibility !== undefined) {
      if (!isValidVisibility(body.visibility)) {
        return c.json({ error: t(getLocale(c), "events.invalid_visibility") }, 400);
      }
      fields.push("visibility = ?"); values.push(body.visibility);
    }
    if (body.url !== undefined) { fields.push("url = ?"); values.push(body.url); }

    if (body.location !== undefined) {
      if (body.location === null) {
        fields.push("location_name = NULL, location_address = NULL, location_latitude = NULL, location_longitude = NULL, location_url = NULL");
      } else {
        fields.push("location_name = ?"); values.push(body.location.name);
        fields.push("location_address = ?"); values.push(body.location.address || null);
        fields.push("location_latitude = ?"); values.push(body.location.latitude ?? null);
        fields.push("location_longitude = ?"); values.push(body.location.longitude ?? null);
        fields.push("location_url = ?"); values.push(body.location.url || null);
      }
    }

    if (body.image !== undefined) {
      if (body.image === null) {
        fields.push("image_url = NULL, image_media_type = NULL, image_alt = NULL, image_attribution = NULL");
      } else {
        fields.push("image_url = ?"); values.push(body.image.url);
        fields.push("image_media_type = ?"); values.push(body.image.mediaType || null);
        fields.push("image_alt = ?"); values.push(body.image.alt || null);
        fields.push("image_attribution = ?");
        values.push(body.image.attribution ? JSON.stringify(body.image.attribution) : null);
      }
    }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      values.push(id);
      db.prepare(`UPDATE events SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }

    if (body.tags !== undefined) replaceTags(id, body.tags);

    const oldAllDay = !!existing.all_day;
    const newAllDay = body.allDay !== undefined ? !!body.allDay : oldAllDay;
    const materialChanges = computeMaterialEventChanges(
      {
        title: existing.title,
        startDate: existing.start_date,
        endDate: existing.end_date,
        allDay: oldAllDay,
        eventTimezone: existingTimezone,
        locationName: existing.location_name,
        locationAddress: existing.location_address,
      },
      {
        title: body.title !== undefined ? body.title : existing.title,
        startDate: nextStart ?? existing.start_date,
        endDate: nextEnd !== undefined ? nextEnd : existing.end_date,
        allDay: newAllDay,
        eventTimezone: nextTimezone !== undefined ? nextTimezone : existingTimezone,
        locationName: body.location === undefined ? existing.location_name : (body.location?.name ?? null),
        locationAddress: body.location === undefined ? existing.location_address : (body.location?.address ?? null),
      },
    );
    const titleChanged = materialChanges.some((change) => change.field === "title");
    const timeChanged = materialChanges.some((change) => change.field === "time");
    const locationChanged = materialChanges.some((change) => change.field === "location");

    if (fields.length > 0) {
      // Only material changes (title, time, location) trigger notifications
      if (materialChanges.length > 0) {
        const ev = readLocalEventById(id);
        if (ev) {
          notifyEventUpdated(db, id, {
            id,
            title: ev.title as string,
            slug: (ev.slug as string | null) || id,
            account: { username: user.username },
            startDate: ev.startDate as string,
            endDate: ev.endDate as string | null,
            allDay: ev.allDay as boolean,
            location: ev.location as { name?: string } | null,
            url: ev.url as string | null,
          }, materialChanges);
        }
      }
    }

    const nextVisibility = normalizeEventVisibility(body.visibility ?? existing.visibility);
    const transitionedToPrivate = existing.visibility !== "private" && nextVisibility === "private";

    if (transitionedToPrivate) {
      const baseUrl = getBaseUrl();
      const actorAccount = db
        .prepare("SELECT username FROM accounts WHERE id = ?")
        .get(existing.account_id) as { username: string } | undefined;
      if (actorAccount) {
        const actorUrl = buildActorUrl(actorAccount.username, baseUrl);
        const deleteActivity = {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: buildUrl(baseUrl, "events", id, "delete"),
          type: "Delete",
          actor: actorUrl,
          object: buildUrl(baseUrl, "events", id),
          ...visibilityToActivityPubAddressing(normalizeEventVisibility(existing.visibility as string), actorUrl),
        };
        deliverToFollowers(db, existing.account_id, deleteActivity).catch(() => {});
      }
    }

    // Deliver Update activity to remote followers
    if (nextVisibility !== "private") {
      const updated = readLocalEventById(id);
      if (updated) {
        const baseUrl = getBaseUrl();
        const actorAccount = db
          .prepare("SELECT username FROM accounts WHERE id = ?")
          .get(existing.account_id) as { username: string } | undefined;
        if (actorAccount) {
          const actorUrl = buildActorUrl(actorAccount.username, baseUrl);
          const updatedAt = new Date().toISOString();
          const addressing = visibilityToActivityPubAddressing(nextVisibility, actorUrl);
          const updateActivity = {
            "@context": [AP_CONTEXT, EVERYCAL_CONTEXT],
            id: buildUrl(baseUrl, "events", id, "update"),
            type: "Update",
            actor: actorUrl,
            published: updatedAt,
            ...addressing,
            object: buildApEventObject({
              id: buildUrl(baseUrl, "events", id),
              name: updated.title as string,
              attributedTo: actorUrl,
              ...addressing,
              allDay: !!updated.allDay,
              startDate: updated.startDate,
              endDate: updated.endDate,
              startAtUtc: updated.startAtUtc,
              endAtUtc: updated.endAtUtc,
              content: updated.description as string | undefined,
              eventTimezone: updated.eventTimezone as string | undefined,
              url: buildEventUrl(actorAccount.username, updated.slug as string, null, baseUrl),
              updated: updatedAt,
            }),
          };
          deliverToFollowers(db, existing.account_id, updateActivity).catch(() => {});
        }
      }
    }

    const updated = readLocalEventById(id);
    if (!updated) return c.json({ error: t(getLocale(c), "events.event_not_found_after_update") }, 500);

    const visibilityChanged = nextVisibility !== existing.visibility;
    const shouldHaveOgImage = isOgEligibleVisibility(nextVisibility);
    const ogRelevantFieldsChanged =
      titleChanged ||
      timeChanged ||
      locationChanged ||
      body.image !== undefined;

    if (ogRelevantFieldsChanged || visibilityChanged) {
      if (shouldHaveOgImage) {
        void generateAndSaveOgImage(db, id)
          .catch((err) => console.error(`[OG] Failed to create OG image for event ${id}:`, err));
      } else {
        await clearLocalOgImage(db, id)
          .catch((err) => console.error(`[OG] Failed to clear OG image for event ${id}:`, err));
      }
    }

    return c.json(updated);
  });

  // ─── DELETE /:id ────────────────────────────────────────────────────────

  router.delete("/:id", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");

    const existing = db
      .prepare("SELECT account_id, visibility FROM events WHERE id = ?")
      .get(id) as { account_id: string; visibility: string } | undefined;
    if (!existing) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);
    if (!canManageIdentityEvents(db, existing.account_id, user.id, "editor")) {
      return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
    }

    const actorAccount = db
      .prepare("SELECT username FROM accounts WHERE id = ?")
      .get(existing.account_id) as { username: string } | undefined;

    const ev = readLocalEventById(id);
    if (ev && actorAccount) {
      notifyEventCancelled(db, id, {
        id,
        title: ev.title as string,
        slug: (ev.slug as string) || id,
        account: { username: actorAccount.username },
        startDate: ev.startDate as string,
        endDate: ev.endDate as string | null,
        allDay: ev.allDay as boolean,
        location: ev.location as { name?: string } | null,
        url: ev.url as string | null,
      });
    }

    await clearLocalOgImage(db, id)
      .catch((err) => console.error(`[OG] Failed to clear OG image for deleted event ${id}:`, err));
    db.prepare("DELETE FROM events WHERE id = ?").run(id);

    const baseUrl = getBaseUrl();
    if (!actorAccount || existing.visibility === "private") return c.json({ ok: true });
    const actorUrl = buildActorUrl(actorAccount.username, baseUrl);
    const deleteActivity = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: buildUrl(baseUrl, "events", id, "delete"),
      type: "Delete",
      actor: actorUrl,
      object: buildUrl(baseUrl, "events", id),
      ...visibilityToActivityPubAddressing(normalizeEventVisibility(existing.visibility as string), actorUrl),
    };
    deliverToFollowers(db, existing.account_id, deleteActivity).catch(() => {});

    return c.json({ ok: true });
  });

}
