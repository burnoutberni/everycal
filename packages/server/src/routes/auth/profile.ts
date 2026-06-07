import type { Hono } from "hono";
import type { DB } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { stripHtml, sanitizeHtml, isValidHttpUrl, normalizeHttpUrlInput } from "../../lib/security.js";
import { getLocale, t } from "../../lib/i18n.js";
import { parseJsonBody } from "../../lib/request-body.js";
import { SYSTEM_TIMEZONE, SYSTEM_DATE_TIME_LOCALE } from "./constants.js";

function accountHasLocation(db: DB, accountId: string): boolean {
  const row = db.prepare("SELECT city, city_lat, city_lng FROM accounts WHERE id = ?").get(accountId) as {
    city: string | null;
    city_lat: number | null;
    city_lng: number | null;
  } | undefined;
  return !!(row?.city && row.city_lat != null && row.city_lng != null);
}

export function registerProfileRoutes(router: Hono, db: DB): void {
  router.patch("/me", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const parsed = await parseJsonBody<{
      displayName?: string;
      bio?: string;
      avatarUrl?: string;
      website?: string;
      isBot?: boolean;
      discoverable?: boolean;
      city?: string | null;
      cityLat?: number | null;
      cityLng?: number | null;
      preferredLanguage?: string;
      timezone?: string;
      dateTimeLocale?: string;
      themePreference?: string;
    }>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (body.displayName !== undefined) {
      fields.push("display_name = ?");
      values.push(stripHtml(body.displayName));
    }
    if (body.bio !== undefined) {
      fields.push("bio = ?");
      values.push(sanitizeHtml(body.bio));
    }
    if (body.avatarUrl !== undefined) {
      if (body.avatarUrl) {
        const normalizedAvatarUrl = normalizeHttpUrlInput(body.avatarUrl);
        if (!isValidHttpUrl(normalizedAvatarUrl)) {
          return c.json({ error: t(getLocale(c), "auth.avatar_url_http") }, 400);
        }
        fields.push("avatar_url = ?");
        values.push(normalizedAvatarUrl);
      } else {
        fields.push("avatar_url = ?");
        values.push(null);
      }
    }
    if (body.website !== undefined) {
      // Validate website URL
      if (body.website) {
        const normalizedWebsite = normalizeHttpUrlInput(body.website);
        if (!isValidHttpUrl(normalizedWebsite)) {
          return c.json({ error: t(getLocale(c), "auth.invalid_website_url") }, 400);
        }
        fields.push("website = ?");
        values.push(normalizedWebsite);
      } else {
        fields.push("website = ?");
        values.push(null);
      }
    }
    if (body.discoverable !== undefined) {
      fields.push("discoverable = ?");
      values.push(body.discoverable ? 1 : 0);
    }
    if (body.city === null && body.cityLat === null && body.cityLng === null) {
      fields.push("city = ?");
      values.push(null);
      fields.push("city_lat = ?");
      values.push(null);
      fields.push("city_lng = ?");
      values.push(null);
    } else if (body.city !== undefined && body.cityLat != null && body.cityLng != null) {
      fields.push("city = ?");
      values.push(body.city);
      fields.push("city_lat = ?");
      values.push(body.cityLat);
      fields.push("city_lng = ?");
      values.push(body.cityLng);
    } else if (body.city !== undefined || body.cityLat !== undefined || body.cityLng !== undefined) {
      return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
    }
    if (body.preferredLanguage !== undefined) {
      const valid = ["en", "de"];
      if (valid.includes(body.preferredLanguage)) {
        fields.push("preferred_language = ?");
        values.push(body.preferredLanguage);
      }
    }
    if (body.timezone !== undefined) {
      if (body.timezone !== SYSTEM_TIMEZONE) {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
        } catch {
          return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
        }
      }
      fields.push("timezone = ?");
      values.push(body.timezone);
    }
    if (body.dateTimeLocale !== undefined) {
      let canonical = body.dateTimeLocale;
      if (body.dateTimeLocale !== SYSTEM_DATE_TIME_LOCALE) {
        try {
          canonical = Intl.getCanonicalLocales(body.dateTimeLocale)[0] || "";
          if (!canonical) throw new Error("invalid locale");
          new Intl.DateTimeFormat(canonical, { dateStyle: "short", timeStyle: "short" });
        } catch {
          return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
        }
      }
      fields.push("date_time_locale = ?");
      values.push(canonical);
    }
    if (body.themePreference !== undefined) {
      const valid = ["system", "light", "dark"];
      if (!valid.includes(body.themePreference)) {
        return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
      }
      fields.push("theme_preference = ?");
      values.push(body.themePreference);
    }

    if (fields.length === 0) {
      return c.json({ error: t(getLocale(c), "auth.no_fields_to_update") }, 400);
    }

    fields.push("updated_at = datetime('now')");
    values.push(user.id);

    db.prepare(`UPDATE accounts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return c.json({ ok: true });
  });

  // Update notification preferences
  router.patch("/notification-prefs", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const parsed = await parseJsonBody<{
      reminderEnabled?: boolean;
      reminderHoursBefore?: number;
      eventUpdatedEnabled?: boolean;
      eventCancelledEnabled?: boolean;
      onboardingCompleted?: boolean;
    }>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed;

    const existing = db
      .prepare("SELECT account_id, reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled, onboarding_completed FROM account_notification_prefs WHERE account_id = ?")
      .get(user.id) as {
        account_id: string;
        reminder_enabled: number;
        reminder_hours_before: number;
        event_updated_enabled: number;
        event_cancelled_enabled: number;
        onboarding_completed: number;
      } | undefined;

    const reminderEnabled = body.reminderEnabled ?? (existing ? !!existing.reminder_enabled : true);
    const reminderHoursBefore = body.reminderHoursBefore ?? existing?.reminder_hours_before ?? 24;
    const eventUpdatedEnabled = body.eventUpdatedEnabled ?? (existing ? !!existing.event_updated_enabled : true);
    const eventCancelledEnabled = body.eventCancelledEnabled ?? (existing ? !!existing.event_cancelled_enabled : true);
    const onboardingCompleted = body.onboardingCompleted ?? (existing ? !!existing.onboarding_completed : false);

    const validHours = [1, 6, 12, 24];
    if (!validHours.includes(reminderHoursBefore)) {
      return c.json({ error: t(getLocale(c), "auth.reminder_hours_invalid") }, 400);
    }

    if (body.onboardingCompleted === true && !accountHasLocation(db, user.id)) {
      return c.json({ error: "auth.city_required" }, 400);
    }

    if (existing) {
      db.prepare(
        `UPDATE account_notification_prefs SET
          reminder_enabled = ?, reminder_hours_before = ?,
          event_updated_enabled = ?, event_cancelled_enabled = ?,
          onboarding_completed = ?
         WHERE account_id = ?`
      ).run(
        reminderEnabled ? 1 : 0,
        reminderHoursBefore,
        eventUpdatedEnabled ? 1 : 0,
        eventCancelledEnabled ? 1 : 0,
        onboardingCompleted ? 1 : 0,
        user.id
      );
    } else {
      db.prepare(
        `INSERT INTO account_notification_prefs (account_id, reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled, onboarding_completed)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        user.id,
        reminderEnabled ? 1 : 0,
        reminderHoursBefore,
        eventUpdatedEnabled ? 1 : 0,
        eventCancelledEnabled ? 1 : 0,
        onboardingCompleted ? 1 : 0
      );
    }

    return c.json({ ok: true });
  });

  router.delete("/me", requireAuth(), (c) => {
    const user = c.get("user")!;

    const lastOwnedIdentities = db
      .prepare(
        `SELECT a.username
         FROM identity_memberships im
         JOIN accounts a ON a.id = im.identity_account_id
         WHERE im.member_account_id = ?
           AND im.role = 'owner'
           AND a.account_type = 'identity'
           AND NOT EXISTS (
             SELECT 1
             FROM identity_memberships im2
             WHERE im2.identity_account_id = im.identity_account_id
               AND im2.role = 'owner'
               AND im2.member_account_id != ?
           )
         ORDER BY a.username ASC`
      )
      .all(user.id, user.id) as Array<{ username: string }>;

    if (lastOwnedIdentities.length > 0) {
      return c.json(
        {
          error: "Cannot delete account while you are the last owner of one or more identities",
          code: "last_identity_owner",
          identities: lastOwnedIdentities.map((row) => row.username),
        },
        409
      );
    }

    const deleteAccount = db.transaction(() => {
      // Preserve identity-owned events authored by this user.
      // They remain with the identity and only lose direct creator link.
      db.prepare("UPDATE events SET created_by_account_id = NULL WHERE created_by_account_id = ?").run(user.id);

      // Delete events + their tags (events table lacks ON DELETE CASCADE)
      const eventIds = db
        .prepare("SELECT id FROM events WHERE account_id = ?")
        .all(user.id) as { id: string }[];
      if (eventIds.length > 0) {
        const deleteTags = db.prepare("DELETE FROM event_tags WHERE event_id = ?");
        const deleteEvent = db.prepare("DELETE FROM events WHERE id = ?");
        for (const { id } of eventIds) {
          deleteTags.run(id);
          deleteEvent.run(id);
        }
      }

      // Delete remote_follows (lacks ON DELETE CASCADE)
      db.prepare("DELETE FROM remote_follows WHERE account_id = ?").run(user.id);

      // Delete the account — cascades to sessions, api_keys, follows,
      // remote_following, event_rsvps, reposts, auto_reposts
      db.prepare("DELETE FROM accounts WHERE id = ?").run(user.id);
    });

    deleteAccount();
    return c.json({ ok: true });
  });
}
